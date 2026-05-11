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
let lastPhaseState = null;
let lastCompletedActionLog = [];

// WebRTC Voice Chat State
let localStream = null;
let isMicEnabled = false;
let peerConnections = {}; // socketId -> RTCPeerConnection
const rtcConfig = {
    iceServers: [
        { urls: ["stun:stun.turnix.io:3478"] },
        {
            username: "a8be6035-3260-4d94-9fee-779246182107",
            credential: "182a38c7b6afd333307818b0b15d9777",
            urls: [
                "turn:eu-central.turnix.io:3478?transport=udp",
                "turn:eu-central.turnix.io:3478?transport=tcp",
                "turns:eu-central.turnix.io:443?transport=udp",
                "turns:eu-central.turnix.io:443?transport=tcp"
            ]
        }
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
const waitingChatInput = document.getElementById('waiting-chat-input');
const btnSendWaitingChat = document.getElementById('btn-send-waiting-chat');
const waitingChat = document.getElementById('waiting-chat');
const generalChat = document.getElementById('general-chat');
const werewolfChat = document.getElementById('werewolf-chat');
const jailChat = document.getElementById('jail-chat');
const ghostChat = document.getElementById('ghost-chat');
const tabBtns = document.querySelectorAll('.tab-btn');
const roleRegistry = window.WerewolfRoles;
const roleDefinitions = roleRegistry.list();
const roleSettingsKeys = roleRegistry.settingKeys();
const wolfRoles = roleRegistry.wolfRoleIds;

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

function getAnonymousAvatarUrl() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
        <rect width="96" height="96" rx="48" fill="#111827"/>
        <circle cx="48" cy="48" r="43" fill="#1f2937" stroke="#66fcf1" stroke-width="3"/>
        <text x="48" y="63" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="700" fill="#66fcf1">?</text>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function isAnonymousMatchEnabled() {
    return currentGameState?.settings?.anonymousMatch === true;
}

function getPlayerNumberLabel(player, fallbackIndex = null) {
    const number = fallbackIndex !== null ? fallbackIndex + 1 : player?.playerIndex;
    return number ? `Người chơi ${number}` : 'Người chơi';
}

function getPlayerCardName(player, fallbackIndex) {
    return isAnonymousMatchEnabled()
        ? `#${fallbackIndex + 1}`
        : `${fallbackIndex + 1}. ${player?.name || 'Không rõ'}`;
}

function getPlayerDisplayName(player, fallbackIndex = null) {
    return isAnonymousMatchEnabled() ? getPlayerNumberLabel(player, fallbackIndex) : (player?.name || 'Không rõ');
}

function getPlayerDisplayNameById(playerId, players) {
    const index = players.findIndex(player => player.id === playerId);
    return getPlayerDisplayName(index >= 0 ? players[index] : null, index >= 0 ? index : null);
}

function getChatSenderIdentity(data) {
    if (isAnonymousMatchEnabled() && data.senderId && currentGameState?.players) {
        const index = currentGameState.players.findIndex(player => player.id === data.senderId);
        if (index >= 0) {
            return {
                name: getPlayerDisplayName(currentGameState.players[index], index),
                avatarUrl: getAnonymousAvatarUrl()
            };
        }
    }

    return {
        name: data.sender || 'Không rõ',
        avatarUrl: getAvatarUrl(data.sender || 'unknown')
    };
}

// --- Audio Manager ---
const audioManager = {
    currentTrack: null,
    currentTrackType: null,
    desiredTrackType: null,
    isMuted: false,
    volumes: {
        lobby: 0.05,
        day: 0.2,
        night: 0.8
    },
    trackFiles: {
        lobby: ['sounds/lobby.mp3'],
        day: ['sounds/day1.mp3', 'sounds/day2.mp3', 'sounds/day3.mp3'],
        night: ['sounds/night1.mp3', 'sounds/night2.mp3', 'sounds/night3.mp3']
    },
    sfxFiles: {
        daybreak: ['sounds/daybreak.mp3'],
        nightfall: ['sounds/nightfall.mp3']
    },
    sfxVolumes: {
        daybreak: 0.2,
        nightfall: 0.9
    },
    audioElements: {},
    sfxElements: {},
    audioContext: null,

    init() {
        for (const [key, files] of Object.entries(this.trackFiles)) {
            this.audioElements[key] = files.map(file => {
                const audio = new Audio(file);
                audio.loop = true;
                audio.volume = this.volumes[key] || 0.5;
                return audio;
            });
        }
        for (const [key, files] of Object.entries(this.sfxFiles)) {
            this.sfxElements[key] = files.map(file => {
                const audio = new Audio(file);
                audio.loop = false;
                audio.volume = this.sfxVolumes[key] || 0.9;
                return audio;
            });
        }

        const btnToggleMusic = document.getElementById('btn-toggle-music');
        btnToggleMusic.addEventListener('click', () => {
            this.isMuted = !this.isMuted;
            btnToggleMusic.textContent = this.isMuted ? '🔇' : '🔊';

            if (this.isMuted) {
                if (this.currentTrack) this.currentTrack.pause();
            } else if (this.desiredTrackType) {
                const desiredTrackType = this.desiredTrackType;
                this.currentTrackType = null;
                this.play(desiredTrackType);
            } else if (this.currentTrack) {
                this.currentTrack.play().catch(() => { });
            }
        });
    },

    play(trackType) {
        this.desiredTrackType = trackType;
        if (this.isMuted) return;
        const tracks = this.audioElements[trackType];
        if (!tracks || tracks.length === 0) return;

        if (this.currentTrackType === trackType && this.currentTrack) {
            if (this.currentTrack.paused) {
                this.currentTrack.play().catch(e => console.log('Auto-play prevented:', e));
            }
            return;
        }

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
        this.currentTrackType = trackType;
        this.currentTrack.play().catch(e => console.log('Auto-play prevented:', e));
    },

    playSfx(sfxType) {
        if (this.isMuted) return;
        const sounds = this.sfxElements[sfxType];
        if (!sounds || sounds.length === 0) return;

        const playCandidate = (index) => {
            const sound = sounds[index];
            if (!sound) return;

            sound.currentTime = 0;
            sound.play().catch(() => playCandidate(index + 1));
        };

        playCandidate(0);
    },

    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => { });
        }
        return this.audioContext;
    },

    playTone({ type = 'sine', frequency = 440, start = 0, duration = 0.2, volume = 0.25, attack = 0.01, release = 0.08, destination = null }) {
        const ctx = this.getAudioContext();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const startAt = ctx.currentTime + start;
        const endAt = startAt + duration;

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0001), startAt + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, endAt + release);
        oscillator.connect(gain);
        gain.connect(destination || ctx.destination);
        oscillator.start(startAt);
        oscillator.stop(endAt + release + 0.02);
    },

    playNoise({ start = 0, duration = 0.25, volume = 0.2, filterType = 'lowpass', frequency = 900, release = 0.08 }) {
        const ctx = this.getAudioContext();
        const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        }

        const source = ctx.createBufferSource();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        const startAt = ctx.currentTime + start;

        filter.type = filterType;
        filter.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(volume, startAt);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration + release);
        source.buffer = buffer;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        source.start(startAt);
        source.stop(startAt + duration + release + 0.02);
    },

    playRoleSfx(sfxType) {
        if (this.isMuted) return;

        if (sfxType === 'witchPoison') {
            this.playNoise({ duration: 0.45, volume: 0.18, filterType: 'bandpass', frequency: 850, release: 0.18 });
            this.playNoise({ start: 0.08, duration: 0.3, volume: 0.12, filterType: 'highpass', frequency: 1400, release: 0.14 });
            this.playTone({ type: 'triangle', frequency: 180, start: 0.02, duration: 0.35, volume: 0.08, release: 0.18 });
        } else if (sfxType === 'doctorProtect' || sfxType === 'maidProtect') {
            this.playTone({ type: 'sine', frequency: 523.25, duration: 0.28, volume: 0.16, release: 0.12 });
            this.playTone({ type: 'sine', frequency: 659.25, start: 0.08, duration: 0.32, volume: 0.14, release: 0.16 });
            this.playTone({ type: 'triangle', frequency: 1046.5, start: 0.16, duration: 0.22, volume: 0.08, release: 0.2 });
        } else if (sfxType === 'witchHeal') {
            this.playTone({ type: 'sine', frequency: 392, duration: 0.28, volume: 0.12, release: 0.14 });
            this.playTone({ type: 'sine', frequency: 587.33, start: 0.1, duration: 0.32, volume: 0.13, release: 0.18 });
            this.playNoise({ start: 0.05, duration: 0.25, volume: 0.05, filterType: 'highpass', frequency: 2200, release: 0.2 });
        } else if (sfxType === 'werewolfKill') {
            this.playTone({ type: 'sawtooth', frequency: 110, duration: 0.25, volume: 0.14, release: 0.12 });
            this.playNoise({ start: 0.05, duration: 0.22, volume: 0.12, filterType: 'lowpass', frequency: 500, release: 0.1 });
        } else if (sfxType === 'seerCheck') {
            this.playTone({ type: 'sine', frequency: 880, duration: 0.18, volume: 0.09, release: 0.16 });
            this.playTone({ type: 'sine', frequency: 1174.66, start: 0.09, duration: 0.22, volume: 0.08, release: 0.18 });
        }
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

        // Cố gắng phát âm thanh, nếu bị chặn thì log ra
        audio.play().catch(e => {
            console.warn("Autoplay bị chặn bởi trình duyệt. Cần tương tác người dùng để phát tiếng:", e);
            showNotification("Trình duyệt đang chặn âm thanh. Hãy nhấn vào màn hình để nghe mọi người nói.");

            // Thêm sự kiện click để resume nếu bị chặn
            const resumeAudio = () => {
                audio.play();
                document.removeEventListener('click', resumeAudio);
            };
            document.addEventListener('click', resumeAudio);
        });

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

function isWolfTeamMember(player) {
    return !!player && (wolfRoles.includes(player.role) || player.isWolfAligned === true);
}

function hasConvertedWolfActions(player) {
    return !!player && player.isWolfAligned === true && !wolfRoles.includes(player.role);
}

function shouldKeepNightActionOpen() {
    return hasConvertedWolfActions(myPlayerInfo);
}

function canUseWerewolfKill() {
    return !!myPlayerInfo && myPlayerInfo.canWerewolfKill === true;
}

function closeActionModal() {
    actionModal.classList.add('hidden');
    actionTargets.innerHTML = '';
    btnConfirmAction.classList.remove('hidden');
    btnCancelAction.textContent = 'Hủy';
    pendingActionType = null;
    actionTargetId = null;
}

function openChoiceModal(title, description, choices) {
    actionTitle.textContent = title;
    actionDescription.textContent = description;
    actionTargets.innerHTML = '';
    btnConfirmAction.classList.add('hidden');
    btnCancelAction.textContent = 'Đóng';

    choices.forEach(choice => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `target-btn${choice.danger ? ' selected' : ''}`;
        btn.textContent = choice.label;
        btn.addEventListener('click', () => {
            closeActionModal();
            if (choice.onClick) choice.onClick();
        });
        actionTargets.appendChild(btn);
    });

    actionModal.classList.remove('hidden');
}

function confirmDoctorHeal(targetId, displayName) {
    openChoiceModal('Bác sĩ', `Xác nhận bảo vệ ${displayName} đêm nay?`, [
        {
            label: 'Bảo vệ',
            onClick: () => {
                actionTargetId = targetId;
                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'DOCTOR_HEAL', targetId });
                if (!shouldKeepNightActionOpen()) nightActionMode = null;
                showNotification(`Đã chọn bảo vệ ${displayName}.`);
                renderPlayersGrid(currentGameState.players);
            }
        },
        { label: 'Hủy' }
    ]);
}

function isNearBottom(container, threshold = 48) {
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    return remaining <= threshold;
}

function inferSystemMessageTheme(message) {
    const normalized = (message || '').toLowerCase();

    if (
        normalized.includes('đã chết') ||
        normalized.includes('chết trong đêm') ||
        normalized.includes('treo cổ') ||
        normalized.includes('bị giết') ||
        normalized.includes('châm lửa')
    ) {
        return 'danger';
    }

    if (normalized.includes('thắng') || normalized.includes('chiến thắng')) {
        return 'victory';
    }

    if (
        normalized.includes('bầy sói') ||
        normalized.includes('soi') ||
        normalized.includes('thuộc phe') ||
        normalized.includes('vai trò') ||
        normalized.includes('nguyền rủa') ||
        normalized.includes('tưới xăng')
    ) {
        return 'mystic';
    }

    if (
        normalized.includes('ban đêm') ||
        normalized.includes('đêm nay') ||
        normalized.includes('sáng nay') ||
        normalized.includes('lượt của bạn') ||
        normalized.includes('không thể nói chuyện')
    ) {
        return 'phase';
    }

    if (
        normalized.includes('đã chọn') ||
        normalized.includes('đã dùng') ||
        normalized.includes('đã bảo vệ') ||
        normalized.includes('đã ru ngủ') ||
        normalized.includes('đã từ bỏ') ||
        normalized.includes('có quyền cắn') ||
        normalized.includes('không thể cứu')
    ) {
        return 'action';
    }

    return 'system';
}

function appendChatMessage(container, data) {
    const shouldStickToBottom = isNearBottom(container);
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg';
    if (data.isSystem) {
        const systemTheme = data.systemTheme || inferSystemMessageTheme(data.message);
        msgDiv.classList.add('system', `system-${systemTheme}`);
    }
    if (data.isWerewolfChannel) msgDiv.classList.add('werewolf');
    if (data.isJailChannel) msgDiv.classList.add('jail');
    if (data.isGhost) msgDiv.classList.add('ghost');

    if (data.isSystem) {
        msgDiv.textContent = data.message;
    } else {
        const senderIdentity = getChatSenderIdentity(data);
        const headerDiv = document.createElement('div');
        headerDiv.className = 'chat-header';

        const avatarImg = document.createElement('img');
        avatarImg.src = senderIdentity.avatarUrl;
        avatarImg.className = 'chat-avatar';
        avatarImg.alt = senderIdentity.name;

        const senderSpan = document.createElement('span');
        senderSpan.className = 'sender';
        senderSpan.textContent = senderIdentity.name + ': ';

        headerDiv.appendChild(avatarImg);
        headerDiv.appendChild(senderSpan);

        msgDiv.appendChild(headerDiv);
        msgDiv.appendChild(document.createTextNode(data.message));
    }

    container.appendChild(msgDiv);
    if (shouldStickToBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

function getActiveChatTarget() {
    const activeTab = document.querySelector('.tab-btn.active');
    return activeTab?.dataset?.target || 'general-chat';
}

function sendRoomChatMessage(inputEl) {
    if (!inputEl) return;
    const msg = inputEl.value.trim();
    if (msg && currentRoomCode) {
        socket.emit('sendMessage', { roomCode: currentRoomCode, message: msg, channel: getActiveChatTarget() });
        inputEl.value = '';
    }
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
    const roles = Object.fromEntries(roleSettingsKeys.map(key => {
        const inputId = `count-${key.replace(/_/g, '-')}`;
        const input = document.getElementById(inputId);
        return [key, input ? (parseInt(input.value, 10) || 0) : 0];
    }));

    return {
        revealRoleOnDeath: document.getElementById('reveal-on-death').checked,
        showDeathCause: document.getElementById('show-death-cause').checked,
        anonymousMatch: document.getElementById('anonymous-match').checked,
        roles
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
    'reveal-on-death',
    'show-death-cause',
    'anonymous-match',
    ...roleSettingsKeys.map(key => `count-${key.replace(/_/g, '-')}`)
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
        lastCompletedActionLog = [];
        hideLobbyActionLog();
        socket.emit('startGame', { roomCode: currentRoomCode, settings: getSettings() });
    }
});

btnSendChat.addEventListener('click', () => sendRoomChatMessage(chatInput));
btnSendWaitingChat.addEventListener('click', () => sendRoomChatMessage(waitingChatInput));

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSendChat.click();
});

waitingChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSendWaitingChat.click();
});

function switchChatTab(targetId) {
    tabBtns.forEach(b => b.classList.remove('active'));
    const targetBtn = document.querySelector(`.tab-btn[data-target="${targetId}"]`);
    if (targetBtn) targetBtn.classList.add('active');

    [generalChat, werewolfChat, jailChat, ghostChat].forEach(box => {
        if (box) box.classList.add('hidden');
    });
    const targetBox = document.getElementById(targetId);
    if (targetBox) targetBox.classList.remove('hidden');
}

function setChatTabVisible(tabId, visible) {
    const tab = document.getElementById(tabId);
    if (tab) tab.classList.toggle('hidden', !visible);
}

function updateSpecialChatTabs() {
    const isNight = currentGameState?.state === 'NIGHT';
    const amAlive = myPlayerInfo?.isAlive !== false;
    const canUseWolfChat = isNight && amAlive && isWolfTeamMember(myPlayerInfo) && !myPlayerInfo?.isJailedTonight;
    const canUseJailChat = isNight && amAlive && !!(myPlayerInfo?.jailerJailedTargetId || myPlayerInfo?.isJailedTonight);
    const canUseGhostChat = !amAlive || (isNight && myPlayerInfo?.role === 'MEDIUM' && !myPlayerInfo?.isJailedTonight);

    setChatTabVisible('werewolf-tab', canUseWolfChat);
    setChatTabVisible('jail-tab', canUseJailChat);
    setChatTabVisible('ghost-tab', canUseGhostChat);

    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab && activeTab.classList.contains('hidden')) {
        switchChatTab('general-chat');
    }
}

function showLobbyChat() {
    waitingChat.classList.remove('hidden');
    waitingChat.style.display = '';
}

function hideLobbyActionLog() {
    const panel = document.getElementById('lobby-action-log-panel');
    if (panel) panel.classList.add('hidden');
}

function showLobbyActionLog(logEntries = lastCompletedActionLog) {
    const panel = document.getElementById('lobby-action-log-panel');
    if (!panel) return;
    renderWinActionLog(logEntries, 'lobby-action-log');
    panel.classList.remove('hidden');
}

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        switchChatTab(btn.dataset.target);
    });
});

btnCancelAction.addEventListener('click', () => {
    closeActionModal();
});

btnConfirmAction.addEventListener('click', () => {
    if (pendingActionType === 'WITCH_NONE' && currentRoomCode) {
        socket.emit('playerAction', {
            roomCode: currentRoomCode,
            actionType: pendingActionType
        });
        closeActionModal();
        showNotification('Hành động đã được xác nhận.');
        return;
    }

    if (actionTargetId && pendingActionType && currentRoomCode) {
        socket.emit('playerAction', {
            roomCode: currentRoomCode,
            actionType: pendingActionType,
            targetId: actionTargetId
        });
        closeActionModal();
        showNotification('Hành động đã được xác nhận.');
    }
});

// Socket Events - Connection & Lobby
socket.on('roomCreated', (data) => {
    currentRoomCode = data.roomCode;
    myPlayerInfo = data.player;
    lastCompletedActionLog = [];
    hideLobbyActionLog();
    displayRoomCode.textContent = currentRoomCode;
    waitingChat.innerHTML = '';
    showLobbyChat();
    waitingChatInput.value = '';
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
    lastCompletedActionLog = [];
    hideLobbyActionLog();
    displayRoomCode.textContent = currentRoomCode;
    waitingChat.innerHTML = '';
    showLobbyChat();
    waitingChatInput.value = '';
    switchScreen('waiting');
    document.getElementById('btn-mic').style.display = 'block';

    document.getElementById('game-settings').classList.remove('hidden');
    const settingsInputs = document.querySelectorAll('#game-settings input, #game-settings select, .stepper-btn');
    settingsInputs.forEach(input => input.disabled = true);
});

socket.on('settingsUpdated', (settings) => {
    if (myPlayerInfo && !myPlayerInfo.isHost) {
        document.getElementById('reveal-on-death').checked = settings.revealRoleOnDeath !== false;
        document.getElementById('show-death-cause').checked = settings.showDeathCause === true;
        document.getElementById('anonymous-match').checked = settings.anonymousMatch === true;

        if (settings.roles) {
            roleSettingsKeys.forEach(key => {
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
    players.forEach((p, idx) => {
        const li = document.createElement('li');
        li.className = 'waiting-player-item';

        const img = document.createElement('img');
        img.id = `avatar-lobby-${p.id}`;
        img.src = getAvatarUrl(p.name);
        img.className = 'player-avatar-small';

        const span = document.createElement('span');
        span.textContent = `${idx + 1}. ${p.name}${p.isHost ? ' 👑' : ''}`;

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

socket.on('roleActionSfx', ({ type }) => {
    audioManager.playRoleSfx(type);
});

// Socket Events - Game
socket.on('gameStateUpdate', (gameState) => {
    const previousPhaseState = lastPhaseState;
    currentGameState = gameState;
    if (gameState.state !== 'LOBBY') {
        hideLobbyActionLog();
    }
    if (gameState.player) {
        myPlayerInfo = gameState.player;
        if (myPlayerInfo.role) setRoleDisplay(myPlayerInfo.role);
    }

    if (gameState.state !== 'NIGHT') {
        nightActionMode = null;
        currentWerewolfVotes = [];
        window.arsoTargets = [];
        hideWitchPanel();
        hideCursedWolfPanel();
    }
    if (gameState.state !== 'VOTE') {
        currentDayVotes = [];
    }
    if (gameState.state === 'DAY') {
        actionTargetId = null; // reset day vote target
    }
    if ((gameState.state === 'DAY' || gameState.state === 'VOTE') && werewolfChat && !werewolfChat.classList.contains('hidden')) {
        switchChatTab('general-chat');
    }

    if (gameState.state === 'ROLE_REVEAL' || gameState.state === 'NIGHT' || gameState.state === 'DAY' || gameState.state === 'VOTE') {
        if (screens.game.classList.contains('hidden')) {
            switchScreen('game');
        }
    }

    // Update Phase Indicator & Theme
    if (gameState.state === 'NIGHT') {
        audioManager.play('night');
        if (previousPhaseState !== 'NIGHT') {
            audioManager.playSfx('nightfall');
        }
        phaseIndicator.textContent = `Đêm ${gameState.dayNumber}`;
        document.body.className = 'phase-night';
        // Hide/Show werewolf chat tab
        if (isWolfTeamMember(myPlayerInfo)) {
            document.getElementById('werewolf-tab').classList.remove('hidden');
        }
    } else if (gameState.state === 'DAY') {
        audioManager.play('day');
        if (previousPhaseState === 'NIGHT') {
            audioManager.playSfx('daybreak');
        }
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

    updateSpecialChatTabs();
    updateAudioMutes();
    renderPlayersGrid(gameState.players);
    lastPhaseState = gameState.state;
});

const legacyRoleTranslations = {
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

const legacyRoleDescriptions = {
    'WEREWOLF': 
      'Phe Ma Sói. Mỗi đêm, bạn cùng bầy sói chọn 1 người để cắn. Mục tiêu của phe Sói là tiêu diệt hết Dân Làng và các phe đối địch.',
  
    'AURA_SEER': 
      'Phe Dân Làng. Mỗi đêm, bạn chọn 1 người để soi hào quang, biết người đó thuộc nhóm Tốt, Xấu hoặc Không xác định.',
  
    'DOCTOR': 
      'Phe Dân Làng. Mỗi đêm, bạn chọn 1 người để bảo vệ khỏi Ma Sói. Không thể bảo vệ cùng một người trong 2 đêm liên tiếp.',
  
    'WITCH': 
      'Phe Dân Làng. Bạn có 2 bình thuốc: 1 bình cứu người bị Sói cắn và 1 bình độc để giết 1 người. Mỗi bình chỉ dùng được 1 lần.',
  
    'FOOL': 
      'Phe Thứ 3. Bạn thắng nếu bị Dân Làng treo cổ vào ban ngày. Hãy khiến mọi người nghi ngờ bạn, nhưng đừng để bị giết vào ban đêm.',
  
    'VILLAGER': 
      'Phe Dân Làng. Bạn không có kỹ năng ban đêm. Hãy quan sát, suy luận và dùng lá phiếu ban ngày để tìm ra Ma Sói.',
  
    'NIGHTMARE_WEREWOLF': 
      'Phe Ma Sói. Ban ngày, bạn có thể ru ngủ 1 người, khiến họ không thể dùng kỹ năng vào đêm kế tiếp. Kỹ năng này dùng tối đa 2 lần.',
  
    'WOLF_SEER': 
      'Phe Ma Sói. Mỗi đêm, bạn có thể soi chính xác vai trò của 1 người. Nếu muốn tham gia cắn cùng bầy Sói, bạn phải bỏ lượt soi.',
  
    'CURSED_WOLF': 
      'Phe Ma Sói. Một lần mỗi ván, bạn có thể nguyền rủa 1 người. Người đó sẽ biến thành Sói vào sáng hôm sau.',
  
    'ARSONIST': 
      'Phe Thứ 3. Mỗi đêm, bạn có thể tưới xăng lên tối đa 2 người. Bạn có 1 lần châm lửa để thiêu toàn bộ những người đã bị tưới xăng.',
  
    'PRIEST': 
      'Phe Dân Làng. Một lần vào ban ngày, bạn có thể tạt nước thánh vào 1 người. Nếu người đó là Sói, họ chết. Nếu không phải Sói, bạn chết.'
  };

const roleTranslations = Object.fromEntries(roleDefinitions.map(role => [role.id, role.name]));
const roleDescriptions = Object.fromEntries(roleDefinitions.map(role => [role.id, role.description]));
const roleColors = Object.fromEntries(roleDefinitions.map(role => [role.id, role.color]));

function getRoleColor(role) {
    return roleColors[role] || 'var(--text)';
}

function setRoleDisplay(role) {
    const name = roleTranslations[role] || role;
    const desc = roleDescriptions[role] || '';

    myRoleDisplay.innerHTML = '';

    const roleName = document.createElement('div');
    roleName.className = 'role-card-name';
    roleName.textContent = name;
    myRoleDisplay.appendChild(roleName);

    const roleDesc = document.createElement('p');
    roleDesc.className = 'role-card-desc';
    roleDesc.textContent = desc;
    myRoleDisplay.appendChild(roleDesc);

    if (myPlayerInfo && myPlayerInfo.isWolfAligned && !wolfRoles.includes(role)) {
        const alignmentNote = document.createElement('p');
        alignmentNote.className = 'role-card-note';
        alignmentNote.textContent = 'Bạn đang theo phe Ma Sói nhưng vẫn giữ kỹ năng vai trò gốc.';
        myRoleDisplay.appendChild(alignmentNote);
    }

    const roleColor = getRoleColor(role);
    myRoleDisplay.style.color = roleColor;
    myRoleDisplay.style.borderColor = roleColor;
    myRoleDisplay.style.backgroundColor = '';
    myRoleDisplay.style.padding = '';
    myRoleDisplay.style.borderRadius = '';
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
    if (!currentGameState || currentGameState.state === 'LOBBY') {
        showLobbyChat();
        appendChatMessage(waitingChat, { isSystem: true, message: msg });
        return;
    }
    appendChatMessage(generalChat, { isSystem: true, message: msg });
});

socket.on('werewolfInfo', (names) => {
    appendChatMessage(werewolfChat, { isSystem: true, systemTheme: 'mystic', message: `Bầy sói đêm nay: ${names}` });
    if (myPlayerInfo && isWolfTeamMember(myPlayerInfo) && !myPlayerInfo.isJailedTonight) {
        document.getElementById('werewolf-tab').classList.remove('hidden');
        switchChatTab('werewolf-chat');
    }
});

// yourTurn: Server tells this client it's their turn to act
socket.on('yourTurn', ({ role }) => {
    if (!myPlayerInfo || !myPlayerInfo.isAlive) return;
    nightActionMode = role;
    actionTargetId = null; // reset any previous selection

    // Show turn notification
    const rName = roleTranslations[role] || role;
    if (role === 'WITCH') {
        showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào player để mở modal chọn thuốc.`);
        if (typeof hideWitchPanel === 'function') hideWitchPanel();
        if (typeof hideCursedWolfPanel === 'function') hideCursedWolfPanel();
    } else if (role === 'CURSED_WOLF') {
        showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào player để mở modal vote hoặc nguyền.`);
        if (typeof hideCursedWolfPanel === 'function') hideCursedWolfPanel();
        if (typeof hideWitchPanel === 'function') hideWitchPanel();
    } else {
        if (typeof hideWitchPanel === 'function') hideWitchPanel();
        if (typeof hideCursedWolfPanel === 'function') hideCursedWolfPanel();
        if (role === 'WOLF_SEER') {
            showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào thẻ để SOI. Nhấn vào tên của bạn để TỪ BỎ QUYỀN SOI.`);
        } else if (role === 'ARSONIST') {
            showNotification(`⏱ Lượt của bạn (${rName})! Nhấn vào 1-2 thẻ để TƯỚI XĂNG. Hoặc nhấn vào chính tên bạn để CHÂM LỬA.`);
        } else if (role === 'RED_LADY') {
            showNotification(`⏱ Lượt của bạn (${rName})! Chọn một người để ghé thăm đêm nay.`);
        } else if (role === 'LOUDMOUTH') {
            showNotification(`⏱ Lượt của bạn (${rName})! Chọn người sẽ bị lộ vai trò khi bạn chết.`);
        } else if (role === 'MAID') {
            showNotification(`⏱ Lượt của bạn (${rName})! Chọn người để bảo vệ đêm nay.`);
        } else if (role === 'AVENGER') {
            showNotification(`⏱ Lượt của bạn (${rName})! Chọn mục tiêu báo thù.`);
        } else if (role === 'JAILER') {
            showNotification(myPlayerInfo?.jailerBullet
                ? `⏱ Lượt của bạn (${rName})! Bạn có thể xử tử người đang bị giam trong đêm nay.`
                : `⏱ Lượt của bạn (${rName})! Bạn có thể nói chuyện với người đang bị giam trong tab Nhà Giam.`);
            switchChatTab('jail-chat');
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
    if (!currentGameState || currentGameState.state === 'LOBBY') {
        showLobbyChat();
        appendChatMessage(waitingChat, data);
        return;
    }

    let container = generalChat;
    if (data.isWerewolfChannel) container = werewolfChat;
    else if (data.isJailChannel) container = jailChat;
    else if (data.isGhost || data.isMediumChannel) container = ghostChat;

    appendChatMessage(container, data);

    // Show chat bubble on player's card (only visible messages with a sender ID)
    if (data.senderId && !data.isSystem && data.message) {
        showChatBubble(data.senderId, data.message);
    }
});

function renderWinActionLog(logEntries = [], containerId = 'lobby-action-log') {
    const logContainer = document.getElementById(containerId);
    if (!logContainer) return;

    logContainer.innerHTML = '';
    if (!Array.isArray(logEntries) || logEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'win-action-log-empty';
        empty.textContent = 'Không có log hành động cho ván này.';
        logContainer.appendChild(empty);
        return;
    }

    const groups = new Map();
    logEntries.forEach(entry => {
        const phase = entry.phase || 'Diễn biến';
        if (!groups.has(phase)) groups.set(phase, []);
        groups.get(phase).push(entry.text || '');
    });

    groups.forEach((items, phase) => {
        const group = document.createElement('section');
        group.className = 'win-action-log-group';

        const title = document.createElement('h3');
        title.textContent = phase;
        group.appendChild(title);

        const list = document.createElement('ol');
        items.forEach(text => {
            const item = document.createElement('li');
            item.textContent = text;
            list.appendChild(item);
        });
        group.appendChild(list);
        logContainer.appendChild(group);
    });
}

socket.on('gameOver', ({ winnerTeam, roles, actionLog = [] }) => {
    phaseIndicator.textContent = 'Kết Thúc';
    timerDisplay.textContent = '--';
    document.body.className = '';
    lastCompletedActionLog = Array.isArray(actionLog) ? actionLog : [];

    const winScreen = document.getElementById('win-screen');
    const winMessage = document.getElementById('win-message');
    const winSub = document.getElementById('win-sub');
    const winIcon = document.getElementById('win-icon');
    const winPlayersList = document.getElementById('win-players-list');
    const winTimer = document.getElementById('win-timer');

    let teamName = "Dân Làng";
    let subText = "Tất cả mối đe dọa đã bị loại bỏ.";
    let icon = "🏘️";

    if (winnerTeam === 'WEREWOLF') {
        teamName = "Ma Sói";
        subText = "Bầy sói đã chiếm quyền kiểm soát ngôi làng!";
        icon = "🐺";
    } else if (winnerTeam === 'ARSONIST') {
        teamName = "Kẻ Phóng Hỏa";
        subText = "Ngôi làng đã biến thành tro bụi!";
        icon = "🔥";
    } else if (winnerTeam === 'FOOL') {
        teamName = "Kẻ Ngốc";
        subText = "Kẻ Ngốc đã đánh lừa tất cả mọi người!";
        icon = "🃏";
    }

    winMessage.textContent = `${teamName} THẮNG!`;
    winSub.textContent = subText;
    winIcon.textContent = icon;

    // Render final roles in win screen
    winPlayersList.innerHTML = '';
    roles.forEach((r, idx) => {
        const item = document.createElement('div');
        item.className = 'win-player-item';
        item.style.animationDelay = `${idx * 0.1}s`;
        item.innerHTML = `
            <img src="${getAvatarUrl(r.name)}" style="width:40px;height:40px;border-radius:50%;border:2px solid var(--border)">
            <strong style="font-size:0.9rem">${r.name}</strong>
            <span class="role-name" style="color:${getRoleColor(r.role)}">${roleTranslations[r.role] || r.role}</span>
        `;
        winPlayersList.appendChild(item);
    });

    winScreen.classList.remove('hidden');

    let timeLeft = 10;
    winTimer.textContent = timeLeft;
    const interval = setInterval(() => {
        timeLeft--;
        winTimer.textContent = timeLeft;
        if (timeLeft <= 0) clearInterval(interval);
    }, 1000);

    showNotification(`Trò chơi kết thúc! ${teamName} chiến thắng.`);
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
    Object.keys(playerBubbleTimers).forEach(id => clearTimeout(playerBubbleTimers[id]));
    Object.keys(playerBubbleTimers).forEach(id => delete playerBubbleTimers[id]);
    Object.keys(activePlayerBubbles).forEach(id => delete activePlayerBubbles[id]);
    hideWitchPanel();
    myRoleDisplay.innerHTML = '?';
    myRoleDisplay.style.color = 'var(--text-main)';
    myRoleDisplay.style.borderColor = 'var(--text-main)';
    document.getElementById('werewolf-tab').classList.add('hidden');
    document.getElementById('jail-tab').classList.add('hidden');
    document.getElementById('ghost-tab').classList.add('hidden');
    showLobbyChat();
    generalChat.innerHTML = '';
    werewolfChat.innerHTML = '';
    jailChat.innerHTML = '';
    ghostChat.innerHTML = '';
    document.getElementById('win-screen').classList.add('hidden');
    switchScreen('waiting');
    showLobbyActionLog();
});

// Track chat bubbles separately from rendered cards, because vote/action updates rebuild the grid.
const playerBubbleTimers = {};
const activePlayerBubbles = {};

function getPlayerCardId(playerId) {
    return `player-card-${playerId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function createChatBubbleElement(message) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = message.length > 40 ? message.slice(0, 40) + 'â€¦' : message;
    return bubble;
}

function removeChatBubble(senderId, animate = true) {
    delete activePlayerBubbles[senderId];
    if (playerBubbleTimers[senderId]) {
        clearTimeout(playerBubbleTimers[senderId]);
        delete playerBubbleTimers[senderId];
    }

    const card = document.getElementById(getPlayerCardId(senderId));
    const bubble = card ? card.querySelector('.chat-bubble') : null;
    if (!bubble) return;

    if (!animate) {
        bubble.remove();
        return;
    }

    bubble.style.opacity = '0';
    bubble.style.transition = 'opacity 0.4s';
    setTimeout(() => bubble.remove(), 400);
}

function attachActiveChatBubble(card, playerId) {
    const activeBubble = activePlayerBubbles[playerId];
    if (!activeBubble) return;

    if (activeBubble.expiresAt <= Date.now()) {
        removeChatBubble(playerId, false);
        return;
    }

    const old = card.querySelector('.chat-bubble');
    if (old) old.remove();
    card.appendChild(createChatBubbleElement(activeBubble.message));
}

function renderPlayersGrid(players) {
    gamePlayersGrid.innerHTML = '';

    const me = players.find(p => p.id === socket.id);
    if (me && myPlayerInfo) myPlayerInfo.isAlive = me.isAlive;

    const total = players.length;
    const container = gamePlayersGrid;
    const playerNumberById = new Map(players.map((player, index) => [player.id, index + 1]));
    const voteCountByTarget = new Map();
    const playerPositionById = new Map();

    players.forEach((player, index) => {
        let radius = 42;
        if (total <= 5) radius = 28;
        else if (total <= 8) radius = 35;

        const angle = (2 * Math.PI * index / total) - Math.PI / 2;
        playerPositionById.set(player.id, {
            x: 50 + radius * Math.cos(angle),
            y: 50 + radius * Math.sin(angle)
        });
    });

    if (currentGameState && currentGameState.state === 'VOTE') {
        currentDayVotes.forEach(vote => {
            if (!vote.targetId) return;
            voteCountByTarget.set(vote.targetId, (voteCountByTarget.get(vote.targetId) || 0) + (vote.voteWeight || 1));
        });
    }

    players.forEach((p, idx) => {
        const div = document.createElement('div');
        div.dataset.playerId = p.id;
        div.id = getPlayerCardId(p.id);
        const displayName = getPlayerDisplayName(p, idx);

        const classes = ['player-card'];
        if (!p.isAlive) classes.push('dead');
        if (p.id === socket.id) classes.push('me');
        if (p.doctorSavedLastNight && currentGameState && (currentGameState.state === 'DAY' || currentGameState.state === 'VOTE')) {
            classes.push('doctor-saved');
        }
        div.className = classes.join(' ');

        // Position in circle using % so it's responsive. Scale radius based on player count.
        const { x: cx, y: cy } = playerPositionById.get(p.id);
        div.style.left = `${cx}%`;
        div.style.top = `${cy}%`;

        // Avatar
        const img = document.createElement('img');
        img.id = `avatar-game-${p.id}`;
        img.src = isAnonymousMatchEnabled() ? getAnonymousAvatarUrl() : getAvatarUrl(p.name);
        img.className = 'player-avatar';
        img.alt = displayName;

        // Name + role label
        const infoDiv = document.createElement('div');
        let displayContent = `<strong style="font-size:0.8rem">${escapeHtml(getPlayerCardName(p, idx))}</strong>`;
        if (p.role) {
            const roleName = roleTranslations[p.role] || p.role;
            displayContent += `<br><span class="revealed-role" style="color:${getRoleColor(p.role)}">${escapeHtml(roleName)}</span>`;
        }
        if (p.auraAlignment) {
            const auraColor = p.auraAlignment === 'Good (Dân Làng)' ? '#22c55e'
                : p.auraAlignment === 'Evil (Ma Sói)' ? '#ef4444'
                    : '#f59e0b';
            displayContent += `<br><span class="revealed-role" style="color:${auraColor}; border-color:${auraColor};">${escapeHtml(p.auraAlignment)}</span>`;
        }
        if (!p.isAlive && p.deathCause) {
            displayContent += `<br><span class="death-cause">${escapeHtml(p.deathCause)}</span>`;
        }
        if (p.doctorSavedLastNight && currentGameState && (currentGameState.state === 'DAY' || currentGameState.state === 'VOTE')) {
            displayContent += '<br><span class="doctor-saved-label">Được bác sĩ cứu</span>';
        }
        infoDiv.innerHTML = displayContent;

        if (currentGameState && currentGameState.state === 'VOTE') {
            const voteCount = voteCountByTarget.get(p.id) || 0;
            if (voteCount > 0) {
                const countBadge = document.createElement('div');
                countBadge.className = 'vote-count-badge';
                countBadge.textContent = `${voteCount}`;
                countBadge.title = `${voteCount} phiếu đang hướng vào ${displayName}`;
                div.appendChild(countBadge);
            }

            const currentVote = currentDayVotes.find(v => v.voterId === p.id);
            if (currentVote && currentVote.targetId && currentVote.targetId !== p.id) {
                const targetPosition = playerPositionById.get(currentVote.targetId);
                const targetNumber = playerNumberById.get(currentVote.targetId);

                if (targetPosition && targetNumber) {
                    const dx = targetPosition.x - cx;
                    const dy = targetPosition.y - cy;
                    const pointer = document.createElement('div');
                    pointer.className = `vote-pointer ${getVotePointerPositionClass(dx, dy)}`;
                    pointer.title = `${displayName} đang vote người số ${targetNumber}`;

                    const hand = document.createElement('span');
                    hand.className = 'vote-pointer-hand';
                    hand.textContent = getVotePointerEmoji(dx, dy);

                    const number = document.createElement('span');
                    number.className = 'vote-pointer-number';
                    number.textContent = `${targetNumber}`;

                    pointer.appendChild(hand);
                    pointer.appendChild(number);
                    div.appendChild(pointer);
                }
            }
        }

        // --- VOTE BADGES ---
        if (false && currentGameState && currentGameState.state === 'VOTE') {
            const voters = currentDayVotes.filter(v => v.targetId === p.id).map(v => getPlayerDisplayNameById(v.voterId, players));
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

        if (currentGameState && currentGameState.state === 'NIGHT' && isWolfTeamMember(myPlayerInfo)) {
            const wolves = currentWerewolfVotes.filter(v => v.targetId === p.id).map(v => getPlayerDisplayNameById(v.voterId, players));
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

        if (myPlayerInfo && myPlayerInfo.role === 'DOCTOR' && myPlayerInfo.doctorProtectedTargetId === p.id) {
            const healBadge = document.createElement('div');
            healBadge.innerHTML = '🛡️';
            healBadge.style.position = 'absolute';
            healBadge.style.top = '5px';
            healBadge.style.left = '5px';
            healBadge.style.fontSize = '1.2rem';
            healBadge.title = 'Đang được bảo vệ đêm nay';
            div.appendChild(healBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'RED_LADY' && myPlayerInfo.redLadyVisitTargetId === p.id) {
            const visitBadge = document.createElement('div');
            visitBadge.innerHTML = '🌹';
            visitBadge.style.position = 'absolute';
            visitBadge.style.top = '5px';
            visitBadge.style.left = '5px';
            visitBadge.style.fontSize = '1.2rem';
            visitBadge.title = 'Đã chọn ghé thăm đêm nay';
            div.appendChild(visitBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'MAID' && myPlayerInfo.maidProtectedTargetId === p.id) {
            const maidBadge = document.createElement('div');
            maidBadge.innerHTML = '🛎️';
            maidBadge.style.position = 'absolute';
            maidBadge.style.top = '5px';
            maidBadge.style.left = '5px';
            maidBadge.style.fontSize = '1.2rem';
            maidBadge.title = 'Đã chọn bảo vệ đêm nay';
            div.appendChild(maidBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'LOUDMOUTH' && myPlayerInfo.loudmouthTargetId === p.id) {
            const loudmouthBadge = document.createElement('div');
            loudmouthBadge.innerHTML = '📣';
            loudmouthBadge.style.position = 'absolute';
            loudmouthBadge.style.top = '5px';
            loudmouthBadge.style.left = '5px';
            loudmouthBadge.style.fontSize = '1.2rem';
            loudmouthBadge.title = 'Vai trò sẽ bị lộ nếu bạn chết';
            div.appendChild(loudmouthBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'AVENGER' && myPlayerInfo.avengerTargetId === p.id) {
            const avengerBadge = document.createElement('div');
            avengerBadge.innerHTML = '🗡️';
            avengerBadge.style.position = 'absolute';
            avengerBadge.style.top = '5px';
            avengerBadge.style.left = '5px';
            avengerBadge.style.fontSize = '1.2rem';
            avengerBadge.title = 'Mục tiêu báo thù';
            div.appendChild(avengerBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'JAILER' && (myPlayerInfo.jailerSelectedTargetId === p.id || myPlayerInfo.jailerJailedTargetId === p.id)) {
            const jailerBadge = document.createElement('div');
            jailerBadge.innerHTML = '🔒';
            jailerBadge.style.position = 'absolute';
            jailerBadge.style.top = '5px';
            jailerBadge.style.left = '5px';
            jailerBadge.style.fontSize = '1.2rem';
            jailerBadge.title = myPlayerInfo.jailerJailedTargetId === p.id ? 'Đang bị bạn giam đêm nay' : 'Sẽ bị giam đêm tới';
            div.appendChild(jailerBadge);
        }

        if (myPlayerInfo && myPlayerInfo.isJailedTonight && p.id === socket.id) {
            const jailedBadge = document.createElement('div');
            jailedBadge.innerHTML = '🔒';
            jailedBadge.style.position = 'absolute';
            jailedBadge.style.top = '5px';
            jailedBadge.style.left = '5px';
            jailedBadge.style.fontSize = '1.2rem';
            jailedBadge.title = 'Bạn đang bị giam';
            div.appendChild(jailedBadge);
        }

        if (myPlayerInfo && myPlayerInfo.role === 'NIGHTMARE_WEREWOLF' && (myPlayerInfo.sleepingPlayerId === p.id || myPlayerInfo.sleptThisNightId === p.id)) {
            const sleepBadge = document.createElement('div');
            sleepBadge.innerHTML = '💤';
            sleepBadge.style.position = 'absolute';
            sleepBadge.style.top = '5px';
            sleepBadge.style.left = '5px';
            sleepBadge.style.fontSize = '1.2rem';
            sleepBadge.title = myPlayerInfo.sleepingPlayerId === p.id ? 'Đã chọn ru ngủ cho đêm tới' : 'Đang bị ru ngủ đêm nay';
            div.appendChild(sleepBadge);
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
                'NIGHTMARE_SLEEP': 'targeted-sleep',
                'ARSONIST_IGNITE': 'targeted-ignite',
                'DOCTOR_HEAL': 'targeted-heal',
                'WITCH_TARGET': 'targeted-see',
                'CURSED_WOLF_TURN': 'targeted-see',
                'RED_LADY_VISIT': 'targeted-visit',
                'LOUDMOUTH_SELECT': 'targeted-reveal',
                'MAID_PROTECT': 'targeted-heal',
                'AVENGER_SELECT': 'targeted-avenge',
                'JAILER_EXECUTE': 'targeted-jail'
            };

            if (p.id === socket.id) {
                if (role === 'WOLF_SEER') {
                    canTarget = true; actionType = 'WOLF_SEER_RESIGN';
                    div.title = "Nhấn để TỪ BỎ quyền soi, bắt đầu đi cắn";
                }
                if (role === 'ARSONIST' && !myPlayerInfo.arsonistIgniteUsed) {
                    canTarget = true; actionType = 'ARSONIST_IGNITE';
                    div.classList.add('targeted-ignite');
                    div.title = "Nhấn để CHÂM LỬA (Tiêu diệt tất cả người bị douse)";
                }
                if (role === 'DOCTOR' && myPlayerInfo.role === 'DOCTOR') {
                    const cantTarget = p.id === myPlayerInfo.doctorLastHealed;
                    if (!cantTarget) {
                        canTarget = true; actionType = 'DOCTOR_HEAL';
                        div.title = "Nhấn để tự bảo vệ đêm nay";
                    }
                    if (myPlayerInfo.doctorProtectedTargetId === p.id) div.classList.add('targeted-heal');
                    if (actionType && p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                }
            } else {
                if (canUseWerewolfKill() && !isWolfTeamMember(p)) {
                    canTarget = true;
                    actionType = 'WEREWOLF_KILL';
                    div.title = "Nhấn để vote cắn người này";
                    if (currentWerewolfVotes.find(v => v.voterId === socket.id && v.targetId === p.id)) div.classList.add(targetClass[actionType]);
                }

                if (role === 'CURSED_WOLF' && nightActionMode === 'CURSED_WOLF') {
                    if (!isWolfTeamMember(p)) {
                        canTarget = true; actionType = 'CURSED_WOLF_TARGET';
                        div.title = "Nhấn chọn làm mục tiêu";
                        if (myPlayerInfo.cursedWolfTarget === p.id) div.classList.add('targeted-see');
                    }
                } else if (roleRegistry.isWolfRole(role) && role !== 'WOLF_SEER' && !isWolfTeamMember(p)) {
                    canTarget = true; actionType = 'WEREWOLF_KILL';
                    div.title = "Nhấn để cắn người này";
                    if (currentWerewolfVotes.find(v => v.voterId === socket.id && v.targetId === p.id)) div.classList.add(targetClass[actionType]);
                } else if (role === 'WOLF_SEER' && !isWolfTeamMember(p)) {
                    if (window.wolfSeerResigned) {
                        canTarget = true; actionType = 'WEREWOLF_KILL';
                        div.title = "Nhấn để cắn người này";
                    } else if (!myPlayerInfo.wolfSeerUsedTonight) {
                        canTarget = true; actionType = 'WOLF_SEER_CHECK';
                        div.title = "Nhấn để Soi vai trò người này";
                    }
                    if (actionType && p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'AURA_SEER' && myPlayerInfo.role === 'AURA_SEER') {
                    if (!myPlayerInfo.auraSeerUsedTonight || hasConvertedWolfActions(myPlayerInfo)) {
                        canTarget = true; actionType = 'AURA_SEER_CHECK';
                        div.title = myPlayerInfo.auraSeerUsedTonight ? "Nhấn để vote giết người này" : "Nhấn để Soi người này";
                        if (p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                    }
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
                    if (myPlayerInfo.doctorProtectedTargetId === p.id) div.classList.add('targeted-heal');
                    if (actionType && p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'RED_LADY' && myPlayerInfo.role === 'RED_LADY') {
                    canTarget = true; actionType = 'RED_LADY_VISIT';
                    div.title = "Nhấn để ghé thăm người này";
                    if (myPlayerInfo.redLadyVisitTargetId === p.id || p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'LOUDMOUTH' && myPlayerInfo.role === 'LOUDMOUTH') {
                    canTarget = true; actionType = 'LOUDMOUTH_SELECT';
                    div.title = "Nhấn để chọn người sẽ bị lộ vai trò khi bạn chết";
                    if (myPlayerInfo.loudmouthTargetId === p.id || p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'MAID' && myPlayerInfo.role === 'MAID') {
                    canTarget = true; actionType = 'MAID_PROTECT';
                    div.title = "Nhấn để bảo vệ người này. Nếu họ bị tấn công, bạn chết thay.";
                    if (myPlayerInfo.maidProtectedTargetId === p.id || p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'AVENGER' && myPlayerInfo.role === 'AVENGER') {
                    canTarget = true; actionType = 'AVENGER_SELECT';
                    div.title = "Nhấn để chọn mục tiêu báo thù";
                    if (myPlayerInfo.avengerTargetId === p.id || p.id === actionTargetId) div.classList.add(targetClass[actionType]);
                } else if (role === 'JAILER' && myPlayerInfo.role === 'JAILER' && myPlayerInfo.jailerJailedTargetId === p.id && myPlayerInfo.jailerBullet) {
                    canTarget = true; actionType = 'JAILER_EXECUTE';
                    div.title = "Nhấn để xử tử người đang bị giam";
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
                        if (!shouldKeepNightActionOpen()) nightActionMode = null;
                        showNotification('Bạn đã châm lửa!');
                        renderPlayersGrid(currentGameState.players);
                        return;
                    }

                    if (actionType === 'ARSONIST_DOUSE') {
                        if (hasConvertedWolfActions(myPlayerInfo) && !isWolfTeamMember(p)) {
                            const hasKillVote = !!currentWerewolfVotes.find(v => v.voterId === socket.id && v.targetId === p.id);
                            openChoiceModal('Hành động ban đêm', `Chọn hành động với ${displayName}.`, [
                                {
                                    label: 'Tưới xăng',
                                    onClick: () => {
                                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'ARSONIST_DOUSE', targetId: p.id });
                                        showNotification(`Đã chọn tưới xăng ${displayName}.`);
                                        renderPlayersGrid(currentGameState.players);
                                    }
                                },
                                {
                                    label: hasKillVote ? 'Bỏ vote giết' : 'Vote giết',
                                    danger: true,
                                    onClick: () => {
                                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WEREWOLF_KILL', targetId: p.id });
                                        showNotification(hasKillVote ? `Đã bỏ vote giết ${displayName}.` : `Đã vote giết ${displayName}.`);
                                        renderPlayersGrid(currentGameState.players);
                                    }
                                },
                                { label: 'Đóng' }
                            ]);
                            return;
                        }
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

                    if (hasConvertedWolfActions(myPlayerInfo) && !isWolfTeamMember(p) && actionType !== 'CURSED_WOLF_TARGET') {
                        const hasKillVote = !!currentWerewolfVotes.find(v => v.voterId === socket.id && v.targetId === p.id);
                        const roleChoices = [];

                        if (actionType === 'AURA_SEER_CHECK') {
                            if (!myPlayerInfo.auraSeerUsedTonight) {
                                roleChoices.push({
                                    label: 'Soi phe',
                                    onClick: () => {
                                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'AURA_SEER_CHECK', targetId: p.id });
                                        showNotification(`Đang soi phe ${displayName}.`);
                                        renderPlayersGrid(currentGameState.players);
                                    }
                                });
                            }
                        } else if (actionType === 'DOCTOR_HEAL') {
                            roleChoices.push({
                                label: 'Bảo vệ',
                                onClick: () => {
                                    confirmDoctorHeal(p.id, displayName);
                                }
                            });
                        } else if (actionType === 'RED_LADY_VISIT') {
                            roleChoices.push({
                                label: 'Ghé thăm',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'RED_LADY_VISIT', targetId: p.id });
                                    showNotification(`Đã chọn ghé thăm ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        } else if (actionType === 'LOUDMOUTH_SELECT') {
                            roleChoices.push({
                                label: 'Chọn tiết lộ',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'LOUDMOUTH_SELECT', targetId: p.id });
                                    showNotification(`Đã chọn ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        } else if (actionType === 'MAID_PROTECT') {
                            roleChoices.push({
                                label: 'Bảo vệ thay',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'MAID_PROTECT', targetId: p.id });
                                    showNotification(`Đã chọn bảo vệ ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        } else if (actionType === 'AVENGER_SELECT') {
                            roleChoices.push({
                                label: 'Chọn báo thù',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'AVENGER_SELECT', targetId: p.id });
                                    showNotification(`Đã chọn ${displayName} làm mục tiêu báo thù.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        } else if (actionType === 'JAILER_EXECUTE') {
                            roleChoices.push({
                                label: 'Xử tử',
                                danger: true,
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'JAILER_EXECUTE', targetId: p.id });
                                    showNotification(`Đã quyết định xử tử ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        } else if (actionType === 'WITCH_TARGET') {
                            if (myPlayerInfo.witchHealPotion) {
                                roleChoices.push({
                                    label: 'Dùng Bình Máu',
                                    onClick: () => {
                                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_HEAL', targetId: p.id });
                                        showNotification(`Đã dùng Bình Máu lên ${displayName}.`);
                                        renderPlayersGrid(currentGameState.players);
                                    }
                                });
                            }
                            if (myPlayerInfo.witchPoisonPotion) {
                                roleChoices.push({
                                    label: 'Dùng Bình Độc',
                                    danger: true,
                                    onClick: () => {
                                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_POISON', targetId: p.id });
                                        showNotification(`Đã dùng Bình Độc lên ${displayName}.`);
                                        renderPlayersGrid(currentGameState.players);
                                    }
                                });
                            }
                        } else if (actionType === 'ARSONIST_DOUSE') {
                            roleChoices.push({
                                label: 'Tưới xăng',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'ARSONIST_DOUSE', targetId: p.id });
                                    showNotification(`Đã chọn tưới xăng ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        }

                        roleChoices.push({
                            label: hasKillVote ? 'Bỏ vote giết' : 'Vote giết',
                            danger: true,
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WEREWOLF_KILL', targetId: p.id });
                                showNotification(hasKillVote ? `Đã bỏ vote giết ${displayName}.` : `Đã vote giết ${displayName}.`);
                                renderPlayersGrid(currentGameState.players);
                            }
                        });

                        roleChoices.push({ label: 'Đóng' });
                        openChoiceModal('Hành động ban đêm', `Chọn hành động với ${displayName}.`, roleChoices);
                        return;
                    }

                    if (actionType === 'CURSED_WOLF_TARGET') {
                        const hasKillVote = !!currentWerewolfVotes.find(v => v.voterId === socket.id && v.targetId === p.id);
                        const hasCurseVote = myPlayerInfo && myPlayerInfo.cursedWolfTarget === p.id;
                        const choices = [];

                        choices.push({
                            label: hasKillVote ? 'Bỏ vote giết' : 'Vote giết',
                            danger: true,
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WEREWOLF_KILL', targetId: p.id });
                                showNotification(hasKillVote ? `Đã bỏ vote giết ${displayName}.` : `Đã vote giết ${displayName}.`);
                            }
                        });

                        if (!myPlayerInfo.cursedWolfUsed || hasCurseVote) {
                            choices.push({
                                label: hasCurseVote ? 'Bỏ nguyền' : 'Nguyền',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'CURSED_WOLF_TURN', targetId: p.id });
                                    myPlayerInfo.cursedWolfTarget = hasCurseVote ? null : p.id;
                                    showNotification(hasCurseVote ? `Đã bỏ nguyền ${displayName}.` : `Đã chọn nguyền ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        }

                        choices.push({ label: 'Bỏ qua' });
                        openChoiceModal('Sói Nguyền', `Chọn hành động với ${displayName}.`, choices);
                        return;
                    }

                    if (actionType === 'WITCH_TARGET') {
                        const choices = [];

                        if (myPlayerInfo.witchHealPotion) {
                            choices.push({
                                label: 'Dùng Bình Máu',
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_HEAL', targetId: p.id });
                                    nightActionMode = null;
                                    showNotification(`Đã dùng Bình Máu lên ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        }

                        if (myPlayerInfo.witchPoisonPotion) {
                            choices.push({
                                label: 'Dùng Bình Độc',
                                danger: true,
                                onClick: () => {
                                    socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_POISON', targetId: p.id });
                                    nightActionMode = null;
                                    showNotification(`Đã dùng Bình Độc lên ${displayName}.`);
                                    renderPlayersGrid(currentGameState.players);
                                }
                            });
                        }

                        choices.push({
                            label: 'Bỏ qua',
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'WITCH_NONE' });
                                nightActionMode = null;
                                showNotification('Đã bỏ qua lượt của Phù Thủy.');
                                renderPlayersGrid(currentGameState.players);
                            }
                        });

                        openChoiceModal('Phù Thủy', `Chọn loại thuốc dùng lên ${displayName}.`, choices);
                        return;
                    }

                    if (['RED_LADY_VISIT', 'LOUDMOUTH_SELECT', 'MAID_PROTECT', 'AVENGER_SELECT', 'JAILER_EXECUTE'].includes(actionType)) {
                        actionTargetId = p.id;
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        if (!shouldKeepNightActionOpen()) nightActionMode = null;

                        const messages = {
                            RED_LADY_VISIT: `Đã chọn ghé thăm ${displayName}.`,
                            LOUDMOUTH_SELECT: `Đã chọn ${displayName}.`,
                            MAID_PROTECT: `Đã chọn bảo vệ ${displayName}.`,
                            AVENGER_SELECT: `Đã chọn ${displayName} làm mục tiêu báo thù.`,
                            JAILER_EXECUTE: `Đã quyết định xử tử ${displayName}.`
                        };
                        showNotification(messages[actionType] || 'Đã chọn mục tiêu.');
                        renderPlayersGrid(currentGameState.players);
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
                            if (!shouldKeepNightActionOpen()) nightActionMode = null;
                            showNotification(`Đang soi xét ${displayName}...`);
                            renderPlayersGrid(currentGameState.players);
                        } else if (actionType === 'DOCTOR_HEAL') {
                            confirmDoctorHeal(p.id, displayName);
                        } else if (actionType === 'WITCH_TARGET' || actionType === 'CURSED_WOLF_TARGET') {
                            renderPlayersGrid(currentGameState.players);
                        }
                    }
                });

            }
        }

        // --- DAY ACTIONS ---
        if ((currentGameState?.state === 'DAY' || currentGameState?.state === 'VOTE') && myPlayerInfo && myPlayerInfo.role === 'MAYOR' && myPlayerInfo.isAlive && p.id === socket.id && !myPlayerInfo.publiclyRevealedRole) {
            div.classList.add('clickable', 'targeted-mayor');
            div.title = 'Nhấn để lộ vai trò Thị Trưởng và nhận phiếu x2';
            div.addEventListener('click', () => {
                openChoiceModal('Thị Trưởng', 'Bạn có muốn lộ vai trò cho cả làng để phiếu treo cổ được tính x2 không?', [
                    {
                        label: 'Lộ vai trò',
                        onClick: () => {
                            socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'MAYOR_REVEAL', targetId: socket.id });
                            showNotification('Đã lộ vai trò Thị Trưởng.');
                        }
                    },
                    { label: 'Đóng' }
                ]);
            });
        }

        if (currentGameState && currentGameState.state === 'DAY' && myPlayerInfo && myPlayerInfo.isAlive && p.isAlive && p.id !== socket.id) {
            let canTarget = false;
            let actionType = null;

            if (myPlayerInfo.role === 'NIGHTMARE_WEREWOLF' && !isWolfTeamMember(p)) {
                canTarget = true; actionType = 'NIGHTMARE_SLEEP';
                if (myPlayerInfo.sleepingPlayerId === p.id) div.classList.add('targeted-sleep');
            } else if (myPlayerInfo.role === 'PRIEST') {
                canTarget = true; actionType = 'PRIEST_WATER';
            } else if (myPlayerInfo.role === 'AVENGER') {
                canTarget = true; actionType = 'AVENGER_SELECT';
                if (myPlayerInfo.avengerTargetId === p.id) div.classList.add('targeted-avenge');
            } else if (myPlayerInfo.role === 'JAILER') {
                canTarget = true; actionType = 'JAILER_SELECT';
                if (myPlayerInfo.jailerSelectedTargetId === p.id) div.classList.add('targeted-jail');
            }

            if (canTarget) {
                div.classList.add('clickable');
                div.title = actionType === 'NIGHTMARE_SLEEP'
                    ? 'Nhấn để ru ngủ (chỉ 2 lần/game)'
                    : actionType === 'AVENGER_SELECT'
                        ? 'Nhấn để chọn mục tiêu báo thù'
                        : actionType === 'JAILER_SELECT'
                            ? 'Nhấn để chọn người sẽ bị giam đêm tới'
                            : 'Nhấn để tạt nước thánh (chỉ 1 lần/game)';
                div.addEventListener('click', () => {
                    if (actionType === 'AVENGER_SELECT') {
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        showNotification(`Đã chọn ${displayName} làm mục tiêu báo thù.`);
                        return;
                    }
                    if (actionType === 'JAILER_SELECT') {
                        socket.emit('playerAction', { roomCode: currentRoomCode, actionType, targetId: p.id });
                        showNotification(`Đã chọn ${displayName} để giam đêm tới.`);
                        return;
                    }

                    actionTitle.textContent = actionType === 'NIGHTMARE_SLEEP' ? 'Kỹ Năng Ru Ngủ' : 'Nước Thánh';
                    actionDescription.textContent = `Bạn có chắc muốn sử dụng kỹ năng lên ${displayName}?`;
                    pendingActionType = actionType;
                    actionTargetId = p.id;
                    actionTargets.innerHTML = ''; // Not used for this modal mode
                    actionModal.classList.remove('hidden');
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
            if (myPlayerInfo && myPlayerInfo.role === 'JAILER' && myPlayerInfo.jailerSelectedTargetId === p.id) {
                div.classList.add('targeted-jail');
            }

            div.addEventListener('click', () => {
                if (myPlayerInfo && myPlayerInfo.role === 'AVENGER') {
                    const myVote = currentDayVotes.find(v => v.voterId === socket.id);
                    const hasVote = myVote && myVote.targetId === p.id;
                    openChoiceModal('Kẻ Báo Thù', `Chọn hành động với ${displayName}.`, [
                        {
                            label: hasVote ? 'Bỏ phiếu treo' : 'Bỏ phiếu',
                            danger: true,
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'VOTE', targetId: p.id });
                            }
                        },
                        {
                            label: 'Chọn báo thù',
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'AVENGER_SELECT', targetId: p.id });
                                showNotification(`Đã chọn ${displayName} làm mục tiêu báo thù.`);
                            }
                        },
                        { label: 'Đóng' }
                    ]);
                    return;
                }
                if (myPlayerInfo && myPlayerInfo.role === 'JAILER') {
                    const myVote = currentDayVotes.find(v => v.voterId === socket.id);
                    const hasVote = myVote && myVote.targetId === p.id;
                    openChoiceModal('Giám Ngục', `Chọn hành động với ${displayName}.`, [
                        {
                            label: hasVote ? 'Bỏ phiếu treo' : 'Bỏ phiếu',
                            danger: true,
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'VOTE', targetId: p.id });
                            }
                        },
                        {
                            label: 'Giam đêm tới',
                            onClick: () => {
                                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'JAILER_SELECT', targetId: p.id });
                                showNotification(`Đã chọn ${displayName} để giam đêm tới.`);
                            }
                        },
                        { label: 'Đóng' }
                    ]);
                    return;
                }
                socket.emit('playerAction', { roomCode: currentRoomCode, actionType: 'VOTE', targetId: p.id });
            });
        }

        attachActiveChatBubble(div, p.id);
        container.appendChild(div);
    });
}

// Show a floating chat bubble on a player's card
function showChatBubble(senderId, message) {
    activePlayerBubbles[senderId] = {
        message,
        expiresAt: Date.now() + 4000
    };

    if (playerBubbleTimers[senderId]) clearTimeout(playerBubbleTimers[senderId]);

    const activeCard = document.getElementById(getPlayerCardId(senderId));
    if (activeCard) attachActiveChatBubble(activeCard, senderId);

    playerBubbleTimers[senderId] = setTimeout(() => {
        removeChatBubble(senderId);
    }, 4000);
    return;

    /*
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
    */
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

function getVotePointerEmoji(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? '👉' : '👈';
    }

    return dy >= 0 ? '👇' : '👆';
}

function getVotePointerPositionClass(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? 'vote-pointer-right' : 'vote-pointer-left';
    }

    return dy >= 0 ? 'vote-pointer-bottom' : 'vote-pointer-top';
}

function triggerDayActionModal(targetPlayer) {
    const targetIndex = currentGameState?.players?.findIndex(player => player.id === targetPlayer.id) ?? -1;
    const targetName = getPlayerDisplayName(targetPlayer, targetIndex >= 0 ? targetIndex : null);
    actionTitle.textContent = 'Bỏ Phiếu Treo Cổ';
    actionDescription.textContent = `Bạn có muốn bỏ phiếu treo cổ ${targetName} không?`;
    pendingActionType = 'VOTE';
    actionTargetId = targetPlayer.id;
    actionTargets.innerHTML = '';
    actionModal.classList.remove('hidden');
}
btnConfirmAction.addEventListener('click', () => {
    return;
    if (pendingActionType && actionTargetId) {
        socket.emit('playerAction', {
            roomCode: currentRoomCode,
            actionType: pendingActionType,
            targetId: actionTargetId
        });
        if (pendingActionType === 'NIGHTMARE_SLEEP') showNotification('Đã chọn ru ngủ mục tiêu.');
        else if (pendingActionType === 'PRIEST_WATER') showNotification('Đã tạt nước thánh!');
        else showNotification('Đã thực hiện hành động.');
    }
    actionModal.classList.add('hidden');
    pendingActionType = null;
    actionTargetId = null;
});

btnCancelAction.addEventListener('click', () => {
    return;
    actionModal.classList.add('hidden');
    pendingActionType = null;
    actionTargetId = null;
});

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
