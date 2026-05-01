const socket = io({
    transports: ['websocket']
});

// State variables
let currentRoomCode = null;
let myPlayerInfo = null;
let currentGameState = null;
let actionTargetId = null;
let pendingActionType = null;
let nightActionMode = null; // role name when it's your turn at night
let currentDayVotes = [];
let currentWerewolfVotes = [];

// WebRTC Voice Chat State
let localStream = null;
let isMicEnabled = false;
let peerConnections = {}; // socketId -> RTCPeerConnection
const rtcConfig = { 
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, 
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ] 
};
let localMutes = {}; // targetId -> boolean

// Audio Analysis for speaking indicator
let audioContext = null;
const analysers = {}; // targetId -> analyserNode
let analyzeInterval = null;

// DOM Elements - Screens
const screens = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-selection-screen'),
    waiting: document.getElementById('waiting-room-screen'),
    game: document.getElementById('game-screen')
};

// DOM Elements - Inputs/Buttons
const playerNameInput = document.getElementById('player-name');
const btnEnter = document.getElementById('btn-enter');
const btnCreateRoom = document.getElementById('btn-create-room');
const roomCodeInput = document.getElementById('room-code-input');
const btnJoinRoom = document.getElementById('btn-join-room');
const btnStartGame = document.getElementById('btn-start-game');

// DOM Elements - Display
const displayRoomCode = document.getElementById('display-room-code');
const waitingPlayersList = document.getElementById('waiting-players-list');
const playerCountDisplay = document.getElementById('player-count');
const hostMessage = document.getElementById('host-message');
const phaseIndicator = document.getElementById('phase-indicator');
const timerDisplay = document.getElementById('timer-display');
const myRoleDisplay = document.getElementById('my-role-display');
const gamePlayersGrid = document.getElementById('game-players-grid');

// DOM Elements - Chat
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const generalChat = document.getElementById('general-chat');
const werewolfChat = document.getElementById('werewolf-chat');
const ghostChat = document.getElementById('ghost-chat');
const tabBtns = document.querySelectorAll('.tab-btn');

// DOM Elements - Action Modal
const actionModal = document.getElementById('action-modal');
const actionTitle = document.getElementById('action-title');
const actionDescription = document.getElementById('action-description');
const actionTargets = document.getElementById('action-targets');
const btnCancelAction = document.getElementById('btn-cancel-action');
const btnConfirmAction = document.getElementById('btn-confirm-action');

// Helper Functions
function getAvatarUrl(name) {
    return `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(name)}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffdfbf,ffd5dc&radius=50`;
}

// --- Audio Manager ---
const audioManager = {
    currentTrack: null,
    isMuted: false,
    volumes: {
        lobby: 0.3,
        day: 0.3,
        night: 0.8
    },
    trackFiles: {
        lobby: ['sounds/lobby.mp3'],
        day: ['sounds/day1.mp3', 'sounds/day2.mp3', 'sounds/day3.mp3'],
        night: ['sounds/night1.mp3', 'sounds/night2.mp3', 'sounds/night3.mp3']
    },
    audioElements: {},

    init() {
        for (const [key, files] of Object.entries(this.trackFiles)) {
            this.audioElements[key] = files.map(file => {
                const audio = new Audio(file);
                audio.loop = true;
                audio.volume = this.volumes[key] || 0.5;
                return audio;
            });
        }

        const btnToggleMusic = document.getElementById('btn-toggle-music');
        btnToggleMusic.addEventListener('click', () => {
            this.isMuted = !this.isMuted;
            btnToggleMusic.textContent = this.isMuted ? '🔇' : '🔊';

            if (this.isMuted) {
                if (this.currentTrack) this.currentTrack.pause();
            } else if (this.currentTrack) {
                this.currentTrack.play().catch(() => { });
            }
        });
    },

    play(trackType) {
        if (this.isMuted) return;
        const tracks = this.audioElements[trackType];
        if (!tracks || tracks.length === 0) return;

        // Pick a random track from the array
        const randomIndex = Math.floor(Math.random() * tracks.length);
        const nextTrack = tracks[randomIndex];

        // If it's already playing, do nothing
        if (this.currentTrack === nextTrack) return;

        if (this.currentTrack) {
            this.currentTrack.pause();
            this.currentTrack.currentTime = 0;
        }

        this.currentTrack = nextTrack;
        this.currentTrack.play().catch(e => console.log('Auto-play prevented:', e));
    }
};

audioManager.init();

// --- WebRTC Functions ---
function setupAnalyzer(id, stream) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        startAudioAnalysis();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analysers[id] = analyser;
    } catch (e) {
        console.warn("Could not setup audio analyzer for", id, e);
    }
}

function updateSpeakingUI(id, isSpeaking) {
    const avatarLobby = document.getElementById(`avatar-lobby-${id}`);
    if (avatarLobby) {
        if (isSpeaking) avatarLobby.classList.add('speaking');
        else avatarLobby.classList.remove('speaking');
    }
    const avatarGame = document.getElementById(`avatar-game-${id}`);
    if (avatarGame) {
        if (isSpeaking) avatarGame.classList.add('speaking');
        else avatarGame.classList.remove('speaking');
    }
}

function startAudioAnalysis() {
    if (analyzeInterval) return;
    const dataArray = new Uint8Array(128);

    analyzeInterval = setInterval(() => {
        for (const [id, analyser] of Object.entries(analysers)) {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const average = sum / dataArray.length;

            const isLocal = id === socket.id;
            let isSpeaking = average > 10; // speaking threshold

            if (isLocal && !isMicEnabled) isSpeaking = false;
            if (!isLocal && localMutes[id]) isSpeaking = false;
            if (currentGameState && currentGameState.state === 'NIGHT') isSpeaking = false;

            updateSpeakingUI(id, isSpeaking);
        }
    }, 150);
}

async function toggleMic() {
    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            isMicEnabled = true;
            document.getElementById('btn-mic').textContent = '🎤';
            document.getElementById('btn-mic').style.background = 'rgba(46, 204, 113, 0.8)';
            if (currentRoomCode) {
                socket.emit('webrtc-join', currentRoomCode);
            }
            setupAnalyzer(socket.id, localStream);
            updateAudioMutes();
        } catch (err) {
            showNotification('Không thể truy cập Microphone: ' + err.message);
        }
    } else {
        isMicEnabled = !isMicEnabled;
        document.getElementById('btn-mic').textContent = isMicEnabled ? '🎤' : '🎙';
        document.getElementById('btn-mic').style.background = isMicEnabled ? 'rgba(46, 204, 113, 0.8)' : 'rgba(0,0,0,0.5)';
        updateAudioMutes();
    }
}

function updateAudioMutes() {
    if (localStream) {
        const isNight = currentGameState && currentGameState.state === 'NIGHT';
        const amIAlive = myPlayerInfo ? myPlayerInfo.isAlive : true;
        const canSpeak = isMicEnabled && !isNight && amIAlive;
        localStream.getAudioTracks()[0].enabled = canSpeak;
    }

    if (!currentGameState) return;
    const isNight = currentGameState.state === 'NIGHT';
    const amIAlive = myPlayerInfo ? myPlayerInfo.isAlive : true;

    for (const p of currentGameState.players) {
        if (p.id === socket.id) continue;
        const audio = document.getElementById(`audio-${p.id}`);
        if (audio) {
            let shouldMute = false;
            if (localMutes[p.id]) shouldMute = true;
            if (isNight) shouldMute = true;
            if (amIAlive && !p.isAlive) shouldMute = true;
            audio.muted = shouldMute;
        }
    }
}

function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[peerId] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-signal', { targetId: peerId, type: 'candidate', payload: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        let audio = document.getElementById(`audio-${peerId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${peerId}`;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = event.streams[0];
        updateAudioMutes();
        setupAnalyzer(peerId, event.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE Connection State (${peerId}):`, pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
            if (peerConnections[peerId]) {
                peerConnections[peerId].close();
                delete peerConnections[peerId];
            }
            const audio = document.getElementById(`audio-${peerId}`);
            if (audio) audio.remove();

            delete analysers[peerId];
            updateSpeakingUI(peerId, false);
            
            // Nếu failed, có thể do Firewall chặn UDP, cần TURN server
            if (pc.iceConnectionState === 'failed') {
                showNotification('Kết nối Voice Chat thất bại. Có thể do Firewall/NAT của bạn chặn kết nối P2P.');
            }
        }
    };

    return pc;
}

document.getElementById('btn-mic').addEventListener('click', toggleMic);

function switchScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.add('hidden'));
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.remove('hidden');
    // Small delay for CSS transition
    setTimeout(() => screens[screenName].classList.add('active'), 50);
}

function showNotification(msg) {
    const container = document.getElementById('notification-container');
    const notif = document.createElement('div');
    notif.className = 'notification';
    notif.textContent = msg;
    container.appendChild(notif);

    setTimeout(() => {
        notif.style.animation = 'slideIn 0.3s ease-out reverse forwards';
        setTimeout(() => notif.remove(), 300);
    }, 4000);
}

function appendChatMessage(container, data) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';
    if (data.isSystem) msgDiv.classList.add('system');
    if (data.isWerewolfChannel) msgDiv.classList.add('werewolf');
    if (data.isGhost) msgDiv.classList.add('ghost');

    if (data.isSystem) {
        msgDiv.textContent = data.message;
    } else {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'chat-header';

        const avatarImg = document.createElement('img');
        avatarImg.src = getAvatarUrl(data.sender);
        avatarImg.className = 'chat-avatar';

        const senderSpan = document.createElement('span');
        senderSpan.className = 'sender';
        senderSpan.textContent = data.sender + ': ';

        headerDiv.appendChild(avatarImg);
        headerDiv.appendChild(senderSpan);

        msgDiv.appendChild(headerDiv);
        msgDiv.appendChild(document.createTextNode(data.message));
    }

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

// Event Listeners - UI
btnEnter.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    if (name) {
        audioManager.play('lobby'); // Bắt đầu phát nhạc chờ
        switchScreen('lobby');
    } else {
        showNotification('Vui lòng nhập tên.');
    }
});

btnCreateRoom.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    socket.emit('createRoom', { playerName: name });
});

btnJoinRoom.addEventListener('click', () => {
    const name = playerNameInput.value.trim();
    const code = roomCodeInput.value.trim();
    if (code.length === 4) {
        socket.emit('joinRoom', { roomCode: code, playerName: name });
    } else {
        showNotification('Vui lòng nhập mã 4 chữ cái hợp lệ.');
    }
});

function getSettings() {
    return {
        revealRoleOnDeath: document.getElementById('reveal-on-death').checked,
        roles: {
            villager: parseInt(document.getElementById('count-villager').value, 10) || 0,
            aura_seer: parseInt(document.getElementById('count-aura-seer').value, 10) || 0,
            doctor: parseInt(document.getElementById('count-doctor').value, 10) || 0,
            witch: parseInt(document.getElementById('count-witch').value, 10) || 0,
            priest: parseInt(document.getElementById('count-priest').value, 10) || 0,
            werewolf: parseInt(document.getElementById('count-werewolf').value, 10) || 0,
            nightmare_werewolf: parseInt(document.getElementById('count-nightmare-werewolf').value, 10) || 0,
            wolf_seer: parseInt(document.getElementById('count-wolf-seer').value, 10) || 0,
            cursed_wolf: parseInt(document.getElementById('count-cursed-wolf').value, 10) || 0,
            arsonist: parseInt(document.getElementById('count-arsonist').value, 10) || 0,
            fool: parseInt(document.getElementById('count-fool').value, 10) || 0
        }
    };
}

let lastSentSettings = null;
function broadcastSettings() {
    if (myPlayerInfo && myPlayerInfo.isHost && currentRoomCode) {
        const settings = getSettings();
        const settingsStr = JSON.stringify(settings);
        if (settingsStr === lastSentSettings) return;
        lastSentSettings = settingsStr;
        socket.emit('updateSettings', { roomCode: currentRoomCode, settings });
    }
}

const settingElements = [
    'reveal-on-death', 'count-villager', 'count-aura-seer', 'count-doctor',
    'count-witch', 'count-priest', 'count-werewolf', 'count-nightmare-werewolf',
    'count-wolf-seer', 'count-cursed-wolf', 'count-arsonist', 'count-fool'
];
settingElements.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', broadcastSettings);
});

// Handle Number Steppers
function updateStepperUI() {
    document.querySelectorAll('.number-stepper').forEach(stepper => {
        const input = stepper.querySelector('input');
        const minusBtn = stepper.querySelector('.minus');
        const plusBtn = stepper.querySelector('.plus');
        if (!input || !minusBtn || !plusBtn) return;

        const val = parseInt(input.value, 10) || 0;
        const min = parseInt(input.min, 10) || 0;
        const max = parseInt(input.max, 10) || 100;

        minusBtn.disabled = (val <= min);
        plusBtn.disabled = (val >= max);
    });
}

document.querySelectorAll('.stepper-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!myPlayerInfo || !myPlayerInfo.isHost) return;

        const inputId = btn.dataset.input;
        const input = document.getElementById(inputId);
        if (!input) return;

        const min = parseInt(input.min, 10) || 0;
        const max = parseInt(input.max, 10) || 100;
        let val = parseInt(input.value, 10) || 0;

        if (btn.classList.contains('plus')) {
            if (val < max) val++;
        } else if (btn.classList.contains('minus')) {
            if (val > min) val--;
        }

        if (input.value != val) {
            input.value = val;
            updateStepperUI();
            broadcastSettings();
        }
    });
});

// Initialize stepper UI
updateStepperUI();

btnStartGame.addEventListener('click', () => {
    if (currentRoomCode) {
        socket.emit('startGame', { roomCode: currentRoomCode, settings: getSettings() });
    }
});

btnSendChat.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (msg && currentRoomCode) {
        socket.emit('sendMessage', { roomCode: currentRoomCode, message: msg });
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSendChat.click();
});

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.chat-box').forEach(box => box.classList.add('hidden'));
        document.getElementById(btn.dataset.target).classList.remove('hidden');
    });
});

btnCancelAction.addEventListener('click', () => {
    actionModal.classList.add('hidden');
    actionTargetId = null;
    pendingActionType = null;
});

btnConfirmAction.addEventListener('click', () => {
    if (pendingActionType === 'WITCH_NONE' && currentRoomCode) {
        socket.emit('playerAction', {
            roomCode: currentRoomCode,
            actionType: pendingActionType
        });
        actionModal.classList.add('hidden');
        showNotification('Hành động đã được xác nhận.');
        return;
    }

    if (actionTargetId && pendingActionType && currentRoomCode) {
        socket.emit('playerAction', {
            roomCode: currentRoomCode,
            actionType: pendingActionType,
            targetId: actionTargetId
        });
        actionModal.classList.add('hidden');
        showNotification('Hành động đã được xác nhận.');
    }
});

// Socket Events - Connection & Lobby
socket.on('roomCreated', (data) => {
    currentRoomCode = data.roomCode;
    myPlayerInfo = data.player;
    displayRoomCode.textContent = currentRoomCode;
    switchScreen('waiting');
    document.getElementById('btn-mic').style.display = 'block';

    document.getElementById('game-settings').classList.remove('hidden');
    if (myPlayerInfo.isHost) {
        btnStartGame.classList.remove('hidden');
        hostMessage.classList.remove('hidden');
        const settingsInputs = document.querySelectorAll('#game-settings input, #game-settings select, .stepper-btn');
        settingsInputs.forEach(input => input.disabled = false);
        updateStepperUI();
    }
});

socket.on('roomJoined', (data) => {
    currentRoomCode = data.roomCode;
    myPlayerInfo = data.player;
    displayRoomCode.textContent = currentRoomCode;
    switchScreen('waiting');
    document.getElementById('btn-mic').style.display = 'block';

    document.getElementById('game-settings').classList.remove('hidden');
    const settingsInputs = document.querySelectorAll('#game-settings input, #game-settings select, .stepper-btn');
    settingsInputs.forEach(input => input.disabled = true);
});

socket.on('settingsUpdated', (settings) => {
    if (myPlayerInfo && !myPlayerInfo.isHost) {
        document.getElementById('reveal-on-death').checked = settings.revealRoleOnDeath;

        // Map new roles
        if (settings.roles) {
            const roleKeys = [
                'villager', 'aura_seer', 'doctor', 'witch', 'priest',
                'werewolf', 'nightmare_werewolf', 'wolf_seer', 'cursed_wolf',
                'arsonist', 'fool'
            ];
            roleKeys.forEach(key => {
                const el = document.getElementById(`count-${key.replace(/_/g, '-')}`);
                if (el && settings.roles[key] !== undefined) {
                    el.value = settings.roles[key];
                }
            });
            updateStepperUI();
        }
    }
});

socket.on('updatePlayers', (players) => {
    // Update waiting room
    waitingPlayersList.innerHTML = '';
    playerCountDisplay.textContent = players.length;
    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'waiting-player-item';

        const img = document.createElement('img');
        img.id = `avatar-lobby-${p.id}`;
        img.src = getAvatarUrl(p.name);
        img.className = 'player-avatar-small';

        const span = document.createElement('span');
        span.textContent = p.playerIndex + '. ' + p.name + (p.isHost ? ' 👑' : '');

        li.appendChild(img);
        li.appendChild(span);

        if (p.id !== socket.id) {
            const muteBtn = document.createElement('button');
            muteBtn.innerHTML = localMutes[p.id] ? '🔇' : '🔊';
            muteBtn.style.marginLeft = '10px';
            muteBtn.style.background = 'rgba(0,0,0,0.3)';
            muteBtn.style.color = '#fff';
            muteBtn.style.border = 'none';
            muteBtn.style.borderRadius = '4px';
            muteBtn.style.cursor = 'pointer';
            muteBtn.onclick = () => {
                localMutes[p.id] = !localMutes[p.id];
                muteBtn.innerHTML = localMutes[p.id] ? '🔇' : '🔊';
                updateAudioMutes();
            };
            li.appendChild(muteBtn);
        }

        waitingPlayersList.appendChild(li);
    });

    // Update game board if in game
    if (currentGameState && currentGameState.state !== 'LOBBY') {
        renderPlayersGrid(players);
    }
});

socket.on('error', (msg) => {
    showNotification(msg);
});

// Socket Events - Game
socket.on('gameStateUpdate', (gameState) => {
    currentGameState = gameState;
    if (gameState.player) {
        myPlayerInfo = gameState.player;
    }

    if (gameState.state !== 'NIGHT') {
        nightActionMode = null;
        currentWerewolfVotes = [];
        hideWitchPanel();
        hideCursedWolfPanel();
    }
    if (gameState.state !== 'VOTE') {
        currentDayVotes = [];
    }
    if (gameState.state === 'DAY') {
        actionTargetId = null; // reset day vote target
    }

    if (gameState.state === 'ROLE_REVEAL' || gameState.state === 'NIGHT' || gameState.state === 'DAY' || gameState.state === 'VOTE') {
        if (screens.game.classList.contains('hidden')) {
            switchScreen('game');
        }
    }

    // Update Phase Indicator & Theme
    if (gameState.state === 'NIGHT') {
        audioManager.play('night');
        phaseIndicator.textContent = `Đêm ${gameState.dayNumber}`;
        document.body.className = 'phase-night';
        // Hide/Show werewolf chat tab
        if (myPlayerInfo && ['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(myPlayerInfo.role)) {
            document.getElementById('werewolf-tab').classList.remove('hidden');
        }
    } else if (gameState.state === 'DAY') {
        audioManager.play('day');
        phaseIndicator.textContent = `Thảo Luận Ngày ${gameState.dayNumber}`;
        document.body.className = 'phase-day';
    } else if (gameState.state === 'VOTE') {
        audioManager.play('day');
        phaseIndicator.textContent = `Bỏ Phiếu Ngày ${gameState.dayNumber}`;
        document.body.className = 'phase-day';
    } else if (gameState.state === 'ROLE_REVEAL') {
        audioManager.play('night');
        phaseIndicator.textContent = 'Lộ Diện';
    }

    updateAudioMutes();
    renderPlayersGrid(gameState.players);
});

const roleTranslations = {
    'WEREWOLF': 'Ma Sói',
    'AURA_SEER': 'Tiên Tri Hào Quang',
    'DOCTOR': 'Bác Sĩ',
    'WITCH': 'Phù Thủy',
    'FOOL': 'Kẻ Ngốc',
    'VILLAGER': 'Dân Làng',
    'NIGHTMARE_WEREWOLF': 'Sói Ác Mộng',
    'WOLF_SEER': 'Sói Tiên Tri',
    'CURSED_WOLF': 'Sói Nguyền',
    'ARSONIST': 'Kẻ Phóng Hỏa',
    'PRIEST': 'Linh Mục'
};

const roleDescriptions = {
    'WEREWOLF': 'Mỗi đêm, chọn một người để hạ sát. Giết hết dân làng để chiến thắng.',
    'AURA_SEER': 'Mỗi đêm, soi một người xem họ thuộc phe Tốt, Xấu hay Không xác định.',
    'DOCTOR': 'Mỗi đêm, bảo vệ một người. Không cứu cùng một người 2 đêm liên tiếp.',
    'WITCH': 'Có 1 bình cứu và 1 bình độc. Dùng mỗi bình tối đa 1 lần.',
    'FOOL': 'Mục tiêu: bị treo cổ! Bị treo cổ là bạn thắng.',
    'VILLAGER': 'Tham gia thảo luận và bỏ phiếu hàng ngày.',
    'NIGHTMARE_WEREWOLF': 'Cùng phe sói. Ban ngày có thể ru ngủ 1 người (2 lần/game), đêm hôm sau họ sẽ mất lượt.',
    'WOLF_SEER': 'Cùng phe sói. Mỗi đêm soi vai trò 1 người. Phải bỏ quyền Soi mới được cắn.',
    'CURSED_WOLF': 'Cùng phe sói. Mỗi ván 1 lần có thể nguyền rủa 1 người thành Sói (sáng hôm sau sẽ biến đổi).',
    'ARSONIST': 'Phe thứ 3. Mỗi đêm tưới xăng 2 người HOẶC châm lửa giết người bị douse.',
    'PRIEST': '1 lần ban ngày, tạt nước thánh 1 người. Sói chết, người tốt thì bạn chết.'
};

function getRoleColor(role) {
    let roleColor = 'var(--text)';
    if (['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(role)) roleColor = 'var(--wolf-red)';
    if (role === 'AURA_SEER') roleColor = '#8c52ff';
    if (role === 'DOCTOR') roleColor = '#2ecc71';
    if (role === 'WITCH') roleColor = '#9b59b6';
    if (role === 'FOOL') roleColor = '#e67e22';
    if (role === 'ARSONIST') roleColor = '#ff5722';
    if (role === 'PRIEST') roleColor = '#00bcd4';
    return roleColor;
}

function setRoleDisplay(role) {
    const name = roleTranslations[role] || role;
    const desc = roleDescriptions[role] || '';
    myRoleDisplay.innerHTML = `<strong>${name}</strong>${desc ? `<br><small style="font-size:0.65rem; opacity:0.8; font-family: var(--font-body); font-style:italic;">${desc}</small>` : ''}`;

    let roleColor = getRoleColor(role);
    myRoleDisplay.style.color = roleColor;
    myRoleDisplay.style.borderColor = roleColor;
}

function showSlotMachine(finalRole) {
    const overlay = document.getElementById('role-reveal-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    const reel = document.getElementById('slot-reel');
    reel.style.transition = 'none';
    reel.style.transform = 'translateY(0)';

    const rolesList = Object.keys(roleTranslations);
    let itemsHTML = '';
    const numSpins = 20;
    for (let i = 0; i < numSpins; i++) {
        const randomRole = rolesList[Math.floor(Math.random() * rolesList.length)];
        itemsHTML += `<div class="slot-item" style="height: 100px; display: flex; justify-content: center; align-items: center; font-size: 1.5rem; font-weight: bold; color: ${getRoleColor(randomRole)}">${roleTranslations[randomRole]}</div>`;
    }
    itemsHTML += `<div class="slot-item final-role" style="height: 100px; display: flex; justify-content: center; align-items: center; font-size: 1.5rem; font-weight: bold;">${roleTranslations[finalRole]}</div>`;
    reel.innerHTML = itemsHTML;

    // Force reflow
    reel.offsetHeight;

    // Animate
    reel.style.transition = 'transform 3s cubic-bezier(0.15, 0.85, 0.1, 1)';
    const itemHeight = 100;
    const targetY = -(numSpins * itemHeight);
    reel.style.transform = `translateY(${targetY}px)`;

    setTimeout(() => {
        const finalEl = reel.querySelector('.final-role');
        if (finalEl) {
            finalEl.style.color = getRoleColor(finalRole);
            finalEl.style.fontSize = '1.8rem';
            finalEl.style.transition = 'all 0.5s';
        }
        setRoleDisplay(finalRole);
    }, 3100);

    setTimeout(() => {
        overlay.classList.add('hidden');
    }, 4500);
}

socket.on('roleAssigned', (role) => {
    if (myPlayerInfo) myPlayerInfo.role = role;
    if (currentGameState && currentGameState.state === 'ROLE_REVEAL') {
        showSlotMachine(role);
    } else {
        setRoleDisplay(role);
    }
});

socket.on('timerUpdate', (time) => {
    timerDisplay.textContent = time;
});

socket.on('systemMessage', (msg) => {
    appendChatMessage(generalChat, { isSystem: true, message: msg });

    // Do NOT auto-reveal ghost chat when someone dies - player manually switches tab
});

socket.on('werewolfInfo', (names) => {
    appendChatMessage(werewolfChat, { isSystem: true, message: `Bầy sói đêm nay: ${names}` });
    document.getElementById('werewolf-tab').classList.remove('hidden');
    // Auto-switch to werewolf tab
    tabBtns.forEach(b => b.classList.remove('active'));
    const wTab = document.getElementById('werewolf-tab');
    wTab.classList.add('active');
    document.querySelectorAll('.chat-box').forEach(box => box.classList.add('hidden'));
    werewolfChat.classList.remove('hidden');
});

// yourTurn: Server tells this client it's their turn to act
socket.on('yourTurn', ({ role }) => {
    if (!myPlayerInfo || !myPlayerInfo.isAlive) return;
    nightActionMode = role;
    actionTargetId = null; // reset any previous selection

    // Show turn notification
    const rName = roleTranslations[role] || role;
    if (role === 'WITCH') {
        showNotification(`⏱ Lượt của bạn (${rName})! Chọn mục tiêu, rồi chọn Thuốc ở bảng bên trái.`);
        showWitchPanel();
        if (typeof hideCursedWolfPanel === 'function') hideCursedWolfPanel();
    } else if (role === 'CURSED_WOLF') {
        showNotification(`⏱ Lượt của bạn (${rName})! Chọn mục tiêu, rồi chọn hành động ở bảng bên trái.`);
        if (typeof showCursedWolfPanel === 'function') showCursedWolfPanel();
        if (typeof hideWitchPanel === 'function') hideWitchPanel();
    } else {
        if (typeof hideWitchPanel === 'function') hideWitchPanel();
        if (typeof hideCursedWolfPanel === 'function') hideCursedWolfPanel();
        if (role === 'WOLF_SEER') {
            showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào thẻ để SOI. Nhấn vào tên của bạn để TỪ BỎ QUYỀN SOI.`);
        } else if (role === 'ARSONIST') {
            showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào 1-2 thẻ để TƯỚI XĂNG. Hoặc nhấn vào chính tên bạn để CHÂM LỬA.`);
        } else {
            showNotification(`⏱ Lượt của bạn (${rName})! Chọn mục tiêu bằng cách nhấn vào thẻ bài (30s).`);
        }
    }

    if (currentGameState) renderPlayersGrid(currentGameState.players);
});

// werewolfVoteUpdate: Show live vote in werewolf chat and update targeted card
socket.on('werewolfVoteUpdate', (voteInfo) => {
    // Update chat occasionally or just rely on badges? The user wanted badges.
    // We can still print to chat, but to avoid spam, maybe we just set currentWerewolfVotes and re-render.
    currentWerewolfVotes = voteInfo;
    if (currentGameState) renderPlayersGrid(currentGameState.players);
});

socket.on('dayVoteUpdate', (voteInfo) => {
    currentDayVotes = voteInfo;
    if (currentGameState) renderPlayersGrid(currentGameState.players);
});

// slotTimerUpdate (đã bỏ trong cơ chế mới, nhưng giữ dummy listener nếu cần)
socket.on('slotTimerUpdate', (timeLeft) => { });

socket.on('chatMessage', (data) => {
    let container = generalChat;
    if (data.isGhost) container = ghostChat;
    if (data.isWerewolfChannel) container = werewolfChat;

    appendChatMessage(container, data);

    // Show chat bubble on player's card (only visible messages with a sender ID)
    if (data.senderId && !data.isSystem && data.message) {
        showChatBubble(data.senderId, data.message);
    }
});

socket.on('gameOver', (roles) => {
    phaseIndicator.textContent = 'Kết Thúc';
    timerDisplay.textContent = '--';
    document.body.className = '';

    // Render final roles
    const grid = document.getElementById('game-players-grid');
    grid.innerHTML = '';
    roles.forEach(r => {
        const div = document.createElement('div');
        div.className = 'player-card';
        div.innerHTML = `<strong>${r.name}</strong><br><span style="color:var(--accent-color)">${roleTranslations[r.role] || r.role}</span>`;
        grid.appendChild(div);
    });

    showNotification('Trò chơi kết thúc! Tự động quay về sảnh sau 5 giây...');
});

socket.on('gameReset', () => {
    audioManager.play('lobby');
    currentGameState = null;
    nightActionMode = null;
    actionTargetId = null;
    window.wolfSeerResigned = false;
    window.arsoTargets = [];
    currentDayVotes = [];
    currentWerewolfVotes = [];
    hideWitchPanel();
    myRoleDisplay.innerHTML = '?';
    myRoleDisplay.style.color = 'var(--text-main)';
    myRoleDisplay.style.borderColor = 'var(--text-main)';
    document.getElementById('werewolf-tab').classList.add('hidden');
    document.getElementById('ghost-tab').classList.add('hidden');
    generalChat.innerHTML = '';
    werewolfChat.innerHTML = '';
    ghostChat.innerHTML = '';
    switchScreen('waiting');
});

// Track bubbles per player
const playerBubbleTimers = {};

function renderPlayersGrid(players) {
    gamePlayersGrid.innerHTML = '';

    const me = players.find(p => p.id === socket.id);
    if (me && myPlayerInfo) myPlayerInfo.isAlive = me.isAlive;

    const total = players.length;
    const container = gamePlayersGrid;

    players.forEach((p, idx) => {
        const div = document.createElement('div');
        div.dataset.playerId = p.id;
        div.id = `player-card-${p.id.replace(/[^a-zA-Z0-9]/g, '_')}`;

        const classes = ['player-card'];
        if (!p.isAlive) classes.push('dead');
        if (p.id === socket.id) classes.push('me');
        div.className = classes.join(' ');

        // Position in circle using % so it's responsive. Scale radius based on player count.
        const angle = (2 * Math.PI * idx / total) - Math.PI / 2;

        let radius = 42;
        if (total <= 5) radius = 28;
        else if (total <= 8) radius = 35;

        const rx = radius; // % radius X
        const ry = radius; // % radius Y
        const cx = 50 + rx * Math.cos(angle);
        const cy = 50 + ry * Math.sin(angle);
        div.style.left = `${cx}%`;
        div.style.top = `${cy}%`;

        // Avatar
        const img = document.createElement('img');
        img.id = `avatar-game-${p.id}`;
        img.src = getAvatarUrl(p.name);
        img.className = 'player-avatar';
        img.alt = p.name;

        // Name + role label
        const infoDiv = document.createElement('div');
        let displayContent = `<strong style="font-size:0.8rem">${p.playerIndex}. ${p.name}</strong>`;
        if (p.role) {
            displayContent += `<br><span style="color:${getRoleColor(p.role)};font-size:0.75rem;font-weight:bold;">${roleTranslations[p.role] || p.role}</span>`;
        }
        infoDiv.innerHTML = displayContent;

        // --- VOTE BADGES ---
        if (currentGameState && currentGameState.state === 'VOTE') {
            const voters = currentDayVotes.filter(v => v.targetId === p.id).map(v => v.voterName);
            if (voters.length > 0) {
                const badge = document.createElement('div');
                badge.className = 'vote-badge';
                badge.innerHTML = `🗳️ ${voters.join(', ')}`;
                badge.style.fontSize = '0.65rem';
                badge.style.color = '#fff';
                badge.style.backgroundColor = 'rgba(230, 126, 34, 0.9)';
                badge.style.padding = '2px 6px';
                badge.style.borderRadius = '10px';
                badge.style.marginTop = '4px';
                infoDiv.appendChild(badge);
            }
        }

        if (currentGameState && currentGameState.state === 'NIGHT' && myPlayerInfo && ['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(myPlayerInfo.role)) {
            const wolves = currentWerewolfVotes.filter(v => v.targetId === p.id).map(v => v.voterName);
            if (wolves.length > 0) {
                const badge = document.createElement('div');
                badge.className = 'vote-badge';
                badge.innerHTML = `🐺 ${wolves.join(', ')}`;
                badge.style.fontSize = '0.65rem';
                badge.style.color = '#fff';
                badge.style.backgroundColor = 'rgba(200, 0, 0, 0.9)';
                badge.style.padding = '2px 6px';
                badge.style.borderRadius = '10px';
                badge.style.marginTop = '4px';
                infoDiv.appendChild(badge);
            }
        }

        // Doused badge for Arsonist
        if (myPlayerInfo && myPlayerInfo.role === 'ARSONIST' && myPlayerInfo.arsonistDoused && myPlayerInfo.arsonistDoused.includes(p.id)) {
            const dousedBadge = document.createElement('div');
            dousedBadge.innerHTML = '⛽';
            dousedBadge.style.position = 'absolute';
            dousedBadge.style.top = '5px';
            dousedBadge.style.left = '5px';
            dousedBadge.style.fontSize = '1.2rem';
            dousedBadge.title = 'Đã bị tưới xăng';
            div.appendChild(dousedBadge);
        }

        div.appendChild(img);
        div.appendChild(infoDiv);

        // Voice Mute Button
        if (p.id !== socket.id) {
            const muteBtn = document.createElement('button');
            muteBtn.innerHTML = localMutes[p.id] ? '🔇' : '🔊';
            muteBtn.style.position = 'absolute';
            muteBtn.style.top = '-10px';
            muteBtn.style.right = '-10px';
            muteBtn.style.background = 'rgba(0,0,0,0.8)';
            muteBtn.style.color = '#fff';
            muteBtn.style.border = 'none';
            muteBtn.style.borderRadius = '50%';
            muteBtn.style.width = '24px';
            muteBtn.style.height = '24px';
            muteBtn.style.cursor = 'pointer';
            muteBtn.style.zIndex = '10';
            muteBtn.onclick = (e) => {
                e.stopPropagation();
                localMutes[p.id] = !localMutes[p.id];
                muteBtn.innerHTML = localMutes[p.id] ? '🔇' : '🔊';
                updateAudioMutes();
            };
            div.appendChild(muteBtn);
        }

        // --- NIGHT ACTIONS via card click ---
        if (currentGameState && currentGameState.state === 'NIGHT' && nightActionMode && myPlayerInfo && myPlayerInfo.isAlive && p.isAlive) {
            const role = nightActionMode;
            let canTarget = false;
            let actionType = null;

            const targetClass = {
                'WEREWOLF_KILL': 'targeted-kill',
                'WOLF_SEER_CHECK': 'targeted-see',
                'AURA_SEER_CHECK': 'targeted-see',
                'ARSONIST_DOUSE': 'targeted-douse',
                'ARSONIST_IGNITE': 'targeted-ignite',
                'DOCTOR_HEAL': 'targeted-heal',
                'WITCH_TARGET': 'targeted-see'
            };

            if (p.id === socket.id) {
                if (role === 'WOLF_SEER') {
                    canTarget = true; actionType = 'WOLF_SEER_RESIGN';
                    div.title = "Nhấn để TỪ BỎ quyền soi, bắt đầu đi cắn";
                }
                if (role === 'ARSONIST') {
                    canTarget = true; actionType = 'ARSONIST_IGNITE';
                    div.classList.add('targeted-ignite');
                    div.title = "Nhấn để CHÂM LỬA (Tiêu diệt tất cả người bị douse)";
                }
            } else {
                if (role === 'CURSED_WOLF' && nightActionMode === 'CURSED_WOLF') {
                    if (!['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(p.role)) {
                        canTarget = true; actionType = 'CURSED_WOLF_TARGET';
                        div.title = "Nhấn chọn làm mục tiêu";
                        if (p.id === actionTargetId) div.classList.add('targeted-see');
                    }
                } else if (['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'CURSED_WOLF'].includes(role) && !['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(p.role)) {
                    canTarget = true; actionType = 'WEREWOLF_KILL';
                    div.title = "Nhấn để cắn người này";
                    if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'WOLF_SEER' && !['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(p.role)) {
                    canTarget = true; actionType = window.wolfSeerResigned ? 'WEREWOLF_KILL' : 'WOLF_SEER_CHECK';
                    div.title = window.wolfSeerResigned ? "Nhấn để cắn người này" : "Nhấn để Soi vai trò người này";
                    if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'AURA_SEER' && myPlayerInfo.role === 'AURA_SEER') {
                    canTarget = true; actionType = 'AURA_SEER_CHECK';
                    div.title = "Nhấn để Soi người này";
                    if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'ARSONIST' && myPlayerInfo.role === 'ARSONIST') {
                    if (myPlayerInfo.arsonistDoused && myPlayerInfo.arsonistDoused.includes(p.id)) {
                        canTarget = false;
                        div.title = "Người này đã bị tưới xăng rồi";
                    } else {
                        canTarget = true; actionType = 'ARSONIST_DOUSE';
                        div.title = "Nhấn để Tưới Xăng (Tối đa 2 người)";
                        if (window.arsoTargets && window.arsoTargets.includes(p.id)) div.classList.add(targetClass[actionType]);
                    }
                } else if (role === 'DOCTOR' && myPlayerInfo.role === 'DOCTOR') {
                    const cantTarget = p.id === myPlayerInfo.doctorLastHealed;
                    if (!cantTarget) {
                        canTarget = true; actionType = 'DOCTOR_HEAL';
                        div.title = "Nhấn để Bảo vệ người này";
                    }
                    if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'WITCH' && nightActionMode === 'WITCH') {
                    canTarget = true; actionType = 'WITCH_TARGET';
                    div.title = "Nhấn chọn làm mục tiêu dùng bình";
                    if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                }
            }

            if (canTarget) {
                div.classList.add('clickable');
                div.addEventListener('click', () => {
                    if (actionType === 'WOLF_SEER_RESIGN') {
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        window.wolfSeerResigned = true;
                        showNotification('Bạn đã từ bỏ quyền soi để cắn người.');
                        return;
                    }
                    if (actionType === 'ARSONIST_IGNITE') {
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        nightActionMode = null;
                        showNotification('Bạn đã châm lửa!');
                        renderPlayersGrid(currentGameState.players);
                        return;
                    }

                    if (actionType === 'ARSONIST_DOUSE') {
                        if (!window.arsoTargets) window.arsoTargets = [];
                        if (window.arsoTargets.includes(p.id)) {
                            window.arsoTargets = window.arsoTargets.filter(t => t !== p.id);
                            div.classList.remove(targetClass['ARSONIST_DOUSE']);
                        } else {
                            if (window.arsoTargets.length >= 2) return showNotification('Chỉ douse tối đa 2 người.');
                            window.arsoTargets.push(p.id);
                            div.classList.add(targetClass['ARSONIST_DOUSE']);
                        }
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        return;
                    }

                    if (actionTargetId === p.id) {
                        actionTargetId = null;
                        div.classList.remove(targetClass[actionType]);
                        if (actionType === 'WEREWOLF_KILL') {
                            socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        }
                    } else {
                        actionTargetId = p.id;
                        document.querySelectorAll('.player-card').forEach(c => {
                            Object.values(targetClass).forEach(cls => c.classList.remove(cls));
                        });
                        div.classList.add(targetClass[actionType]);
                        if (actionType === 'WEREWOLF_KILL') {
                            socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        } else if (actionType === 'AURA_SEER_CHECK' || actionType === 'WOLF_SEER_CHECK') {
                            socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                            nightActionMode = null;
                            showNotification(`Đang soi xét ${p.name}...`);
                            renderPlayersGrid(currentGameState.players);
                        } else if (actionType === 'DOCTOR_HEAL') {
                            socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                            nightActionMode = null;
                            showNotification(`Đã bảo vệ ${p.name} đêm nay.`);
                            renderPlayersGrid(currentGameState.players);
                        } else if (actionType === 'WITCH_TARGET' || actionType === 'CURSED_WOLF_TARGET') {
                            renderPlayersGrid(currentGameState.players);
                        }
                    }
                });

            }
        }

        // --- DAY ACTIONS ---
        if (currentGameState && currentGameState.state === 'DAY' && myPlayerInfo && myPlayerInfo.isAlive && p.isAlive && p.id !== socket.id) {
            let canTarget = false;
            let actionType = null;

            if (myPlayerInfo.role === 'NIGHTMARE_WEREWOLF' && !['WEREWOLF', 'NIGHTMARE_WEREWOLF', 'WOLF_SEER', 'CURSED_WOLF'].includes(p.role)) {
                canTarget = true; actionType = 'NIGHTMARE_SLEEP';
            } else if (myPlayerInfo.role === 'PRIEST') {
                canTarget = true; actionType = 'PRIEST_WATER';
            }

            if (canTarget) {
                div.classList.add('clickable');
                div.title = actionType === 'NIGHTMARE_SLEEP' ? 'Nhấn đúp để ru ngủ (chỉ 2 lần/game)' : 'Nhấn đúp để tạt nước thánh (chỉ 1 lần/game)';
                div.addEventListener('dblclick', () => {
                    if (confirm(`Bạn có chắc muốn sử dụng kỹ năng đặc biệt lên ${p.name}?`)) {
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                    }
                });
            }
        }

        // --- VOTE: click to vote ---
        if (currentGameState && currentGameState.state === 'VOTE' && me && me.isAlive && p.isAlive && p.id !== socket.id) {
            div.classList.add('clickable');

            // Highlight if I voted for them
            const myVote = currentDayVotes.find(v => v.voterId === socket.id);
            if (myVote && myVote.targetId === p.id) {
                div.classList.add('targeted-vote');
            }

            div.addEventListener('click', () => {
                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'VOTE', targetId: p.id });
            });
        }

        container.appendChild(div);
    });
}

// Show a floating chat bubble on a player's card
function showChatBubble(senderId, message) {
    const safeId = senderId.replace(/[^a-zA-Z0-9]/g, '_');
    const card = document.getElementById(`player-card-${safeId}`);
    if (!card) return;

    // Remove existing bubble
    const old = card.querySelector('.chat-bubble');
    if (old) old.remove();
    if (playerBubbleTimers[senderId]) clearTimeout(playerBubbleTimers[senderId]);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    // Truncate long messages
    bubble.textContent = message.length > 40 ? message.slice(0, 40) + '…' : message;
    card.appendChild(bubble);

    // Auto-remove after 4 seconds
    playerBubbleTimers[senderId] = setTimeout(() => {
        bubble.style.opacity = '0';
        bubble.style.transition = 'opacity 0.4s';
        setTimeout(() => bubble.remove(), 400);
    }, 4000);
}


// --- Witch inline panel ---
function showWitchPanel() {
    let panel = document.getElementById('witch-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'witch-panel';
        panel.className = 'action-panel panel';
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.appendChild(panel);
        else document.getElementById('game-screen').appendChild(panel);
    }
    panel.innerHTML = `
        <h3>🧌 Phù Thủy</h3>
        <p>Chọn mục tiêu ở giữa, sau đó chọn loại thuốc.</p>
        <div class="action-btns">
            <button id="btn-witch-none" class="btn secondary">Bỏ Qua ❌</button>
            ${myPlayerInfo.witchHealPotion ? '<button id="btn-witch-heal" class="btn primary" style="background:#2ecc71; color:#fff;">❤️ Dùng Bình Máu</button>' : ''}
            ${myPlayerInfo.witchPoisonPotion ? '<button id="btn-witch-poison" class="btn primary" style="background: var(--wolf-red); color:#fff;">☠️ Dùng Bình Độc</button>' : ''}
        </div>
    `;
    panel.classList.remove('hidden');

    // Render grid for selection (can select any alive player)
    if (currentGameState) renderPlayersGrid(currentGameState.players);

    document.getElementById('btn-witch-none').onclick = () => {
        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_NONE' });
        nightActionMode = null;
        hideWitchPanel();
        showNotification('Bạn đã bỏ qua lượt này.');
        if (currentGameState) renderPlayersGrid(currentGameState.players);
    };

    const healBtn = document.getElementById('btn-witch-heal');
    if (healBtn) healBtn.onclick = () => {
        if (!actionTargetId) return showNotification('Hãy chọn mục tiêu trước!');
        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_HEAL', targetId: actionTargetId });
        nightActionMode = null;
        hideWitchPanel();
        showNotification('Đã dùng Bình Máu.');
        if (currentGameState) renderPlayersGrid(currentGameState.players);
    };

    const poisonBtn = document.getElementById('btn-witch-poison');
    if (poisonBtn) poisonBtn.onclick = () => {
        if (!actionTargetId) return showNotification('Hãy chọn mục tiêu trước!');
        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_POISON', targetId: actionTargetId });
        nightActionMode = null;
        hideWitchPanel();
        showNotification('Đã dùng Bình Độc.');
        if (currentGameState) renderPlayersGrid(currentGameState.players);
    };
}

function hideWitchPanel() {
    const panel = document.getElementById('witch-panel');
    if (panel) panel.classList.add('hidden');
}

function showCursedWolfPanel() {
    let panel = document.getElementById('cursed-wolf-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'cursed-wolf-panel';
        panel.className = 'action-panel panel';
        document.querySelector('.sidebar').appendChild(panel);
    }
    panel.innerHTML = `
        <h3>☣️ Sói Nguyền</h3>
        <p>Chọn mục tiêu ở giữa, sau đó ấn hành động.</p>
        <div class="action-btns">
            <button id="btn-cw-kill" class="btn primary" style="background: var(--wolf-red);">🐺 Cắn Giết</button>
            <button id="btn-cw-curse" class="btn primary" style="background: var(--accent);">☣️ Nguyền Rủa</button>
        </div>
    `;
    panel.classList.remove('hidden');

    document.getElementById('btn-cw-kill').onclick = () => {
        if (!actionTargetId) return showNotification('Hãy chọn mục tiêu trước!');
        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WEREWOLF_KILL', targetId: actionTargetId });
        showNotification('Đã chọn Cắn.');
    };

    document.getElementById('btn-cw-curse').onclick = () => {
        if (!actionTargetId) return showNotification('Hãy chọn mục tiêu trước!');
        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'CURSED_WOLF_TURN', targetId: actionTargetId });
        showNotification('Đã chọn Nguyền rủa.');
    };
}

function hideCursedWolfPanel() {
    const panel = document.getElementById('cursed-wolf-panel');
    if (panel) panel.classList.add('hidden');
}

function triggerDayActionModal(targetPlayer) {
    actionTitle.textContent = 'Bỏ Phiếu Treo Cổ';
    actionDescription.textContent = `Bạn có muốn bỏ phiếu treo cổ ${targetPlayer.name} không?`;
    pendingActionType = 'VOTE';
    actionTargetId = targetPlayer.id;
    actionTargets.innerHTML = '';
    actionModal.classList.remove('hidden');
}

// WebRTC Signaling
socket.on('webrtc-peer-joined', async (peerId) => {
    if (localStream) {
        const pc = createPeerConnection(peerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-signal', { targetId: peerId, type: 'offer', payload: offer });
    }
});

socket.on('webrtc-signal', async ({ senderId, type, payload }) => {
    if (!localStream) return;

    let pc = peerConnections[senderId];

    if (type === 'offer') {
        if (!pc) pc = createPeerConnection(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { targetId: senderId, type: 'answer', payload: answer });
    } else if (type === 'answer') {
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (type === 'candidate') {
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload));
    }
});
