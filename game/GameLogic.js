const RoleRegistry = require('../shared/roleRegistry');

const EVIL_ROLES = RoleRegistry.evilRoleIds;
const GOOD_ROLES = RoleRegistry.goodRoleIds;

class GameLogic {
    constructor(roomCode, io) {
        this.roomCode = roomCode;
        this.io = io;
        this.players = {}; // socketId -> { id, name, isHost, role, isAlive }
        this.state = 'LOBBY'; // LOBBY, ROLE_REVEAL, NIGHT, DAY, GAME_OVER
        this.dayNumber = 0;
        this.timer = null;
        
        this.nightActions = {};
        this.dayVotes = {};
        this.witchHealPotion = true;
        this.witchPoisonPotion = true;
        this.doctorLastHealed = null;
        this.doctorProtectedTargetId = null;
        this.revealRoleOnDeath = true; // setting: show role when player dies
        this.nextPlayerIndex = 1;
        
        this.nightmareSleepCharges = 2;
        this.sleepingPlayerId = null;
        this.sleptThisNightId = null;
        this.arsonistDoused = [];
        this.arsonistNewlyDoused = [];
        this.priestUsed = false;
        this.wolfSeerResigned = false;
        this.cursedWolfUsed = false;
        this.cursedWolfTarget = null;
        this.tempArsoTargets = {};
        this.arsonistIgniteUsed = false;
    }

    isWolfAligned(player) {
        return !!player && (RoleRegistry.isWolfRole(player.role) || player.isWolfAligned === true);
    }

    hasNightAction(player) {
        return this.isWolfAligned(player) || RoleRegistry.hasNightAction(player?.role);
    }

    canWolfTeamRevealRole(viewer, target) {
        return this.isWolfAligned(viewer) && this.isWolfAligned(target);
    }

    addPlayer(socketId, name, isHost) {
        this.players[socketId] = {
            id: socketId,
            playerIndex: this.nextPlayerIndex++,
            name: name,
            isHost: isHost,
            role: null,
            isWolfAligned: false,
            isAlive: true,
            seenRoles: {}, // targetId -> roleName
            seenAuras: {}, // targetId -> Good | Evil | Unknown
            auraSeerUsedTonight: false,
            wolfSeerUsedTonight: false
        };
        return this.players[socketId];
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        // If host leaves, assign new host
        const remainingIds = Object.keys(this.players);
        if (remainingIds.length > 0 && !Object.values(this.players).some(p => p.isHost)) {
            this.players[remainingIds[0]].isHost = true;
        }
        
        // If game in progress, check win condition
        if (this.state !== 'LOBBY') {
            this.checkWinCondition();
        }
    }

    getPlayers(forSocketId) {
        const forPlayer = this.players[forSocketId];
        
        return Object.values(this.players).map(p => {
            let reveal = false;
            if (p.id === forSocketId) reveal = true;
            if (this.state === 'GAME_OVER' || (!p.isAlive && this.revealRoleOnDeath)) reveal = true;
            if (this.canWolfTeamRevealRole(forPlayer, p)) reveal = true;
            
            return {
                id: p.id,
                playerIndex: p.playerIndex,
                name: p.name,
                isHost: p.isHost,
                isAlive: p.isAlive,
                role: (reveal || (forPlayer && forPlayer.seenRoles && forPlayer.seenRoles[p.id])) ? p.role : null,
                isWolfAligned: this.isWolfAligned(p),
                auraAlignment: (forPlayer && forPlayer.seenAuras && forPlayer.seenAuras[p.id]) ? forPlayer.seenAuras[p.id] : null
            };
        });
    }

    startGame(socketId, settings) {
        const playerCount = Object.keys(this.players).length;
        // Default settings match new structure
        settings = settings || { 
            revealRoleOnDeath: true, 
            roles: { villager: playerCount - 1, werewolf: 1 } 
        };

        // Save game settings
        this.revealRoleOnDeath = settings.revealRoleOnDeath !== false;

        let requiredRolesCount = 0;
        if (settings.roles) {
            for (const key in settings.roles) {
                requiredRolesCount += Number(settings.roles[key]);
            }
        }

        if (playerCount !== requiredRolesCount) {
            this.io.to(socketId).emit('error', `Tổng số lượng role (${requiredRolesCount}) phải bằng với số lượng người chơi (${playerCount}).`);
            return;
        }

        this.assignRoles(settings);
        this.state = 'ROLE_REVEAL';
        this.updateClientState();

        for (const socketId in this.players) {
            this.io.to(socketId).emit('roleAssigned', this.players[socketId].role);
        }

        this.broadcastSystemMessage('Trò chơi đã bắt đầu. Hãy kiểm tra vai trò của bạn.');
        setTimeout(() => this.startNight(), 5000);
    }

    assignRoles(settings) {
        const ids = Object.keys(this.players);
        // Shuffle ids
        for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
        }

        const roles = this.buildRoleDeck(settings.roles);
        
        console.log(`[Room ${this.roomCode}] Assigning roles to ${ids.length} players:`, roles);
        
        // Final safety check
        while (roles.length < ids.length) {
            roles.push('VILLAGER');
        }

        ids.forEach((id, index) => {
            this.players[id].role = roles[index];
            this.players[id].isWolfAligned = RoleRegistry.isWolfRole(roles[index]);
        });
    }

    buildRoleDeck(roleCounts = {}) {
        return RoleRegistry.list().flatMap(role => {
            const count = Number(roleCounts[role.settingsKey]) || 0;
            return Array.from({ length: count }, () => role.id);
        });
    }

    startNight() {
        this.state = 'NIGHT';
        this.dayNumber++;
        this.nightActions = []; // Mảng chứa các object action để dễ dàng mở rộng
        this.werewolfVotes = {};
        this.tempArsoTargets = {};
        this.cursedWolfTarget = null;
        this.doctorProtectedTargetId = null;
        Object.values(this.players).forEach(p => {
            p.auraSeerUsedTonight = false;
            p.wolfSeerUsedTonight = false;
        });
        
        this.sleptThisNightId = this.sleepingPlayerId;
        this.sleepingPlayerId = null;
        
        if (this.sleptThisNightId && this.players[this.sleptThisNightId] && this.players[this.sleptThisNightId].isAlive) {
            this.io.to(this.sleptThisNightId).emit('systemMessage', 'Bạn đã bị Sói Ác Mộng ru ngủ. Đêm nay bạn không thể sử dụng kỹ năng.');
        }

        this.updateClientState();
        this.broadcastSystemMessage(`Đêm ${this.dayNumber} buông xuống. Mọi người đi ngủ.`);

        // Inform wolves of each other
        const werewolves = Object.values(this.players).filter(p => this.isWolfAligned(p) && p.isAlive);
        const werewolfNames = werewolves.map(w => w.name).join(', ');
        
        if (werewolves.length === 1 && werewolves[0].role === 'WOLF_SEER') {
            this.wolfSeerResigned = true;
            this.io.to(werewolves[0].id).emit('systemMessage', 'Bạn là sói cuối cùng. Bạn bị tước quyền Soi và giờ có quyền cắn người!');
        }

        werewolves.forEach(w => this.io.to(w.id).emit('werewolfInfo', werewolfNames));

        // 30-second total night timer
        this.nightTimeLeft = 30;

        // Broadcast global 30s countdown
        this.io.to(this.roomCode).emit('timerUpdate', this.nightTimeLeft);

        // Kích hoạt tất cả role có khả năng hành động ban đêm
        Object.values(this.players).forEach(p => {
            if (p.isAlive && this.hasNightAction(p) && p.id !== this.sleptThisNightId) {
                this.io.to(p.id).emit('yourTurn', { role: p.role, timeLeft: 30 });
            }
        });

        // Loop ban đêm
        this.nightTimer = setInterval(() => {
            this.nightTimeLeft--;
            this.io.to(this.roomCode).emit('timerUpdate', this.nightTimeLeft);
            
            if (this.nightTimeLeft <= 0) {
                clearInterval(this.nightTimer);
                this.nightTimer = null;
                
                // Thu thập vote của sói
                const votes = Object.values(this.werewolfVotes);
                if (votes.length > 0) {
                    // Nếu các sói đồng thuận 1 mục tiêu thì giết, nếu không random mục tiêu được vote
                    const allSame = votes.every(v => v === votes[0]);
                    const target = allSame ? votes[0] : votes[Math.floor(Math.random() * votes.length)];
                    this.nightActions.push({ type: 'WEREWOLF_KILL', targetId: target, priority: 3 });
                }
                
                this.resolveNightActions();
            }
        }, 1000);
    }



    broadcastWerewolfVotes() {
        const werewolves = Object.values(this.players).filter(p => this.isWolfAligned(p) && p.isAlive);
        const voteInfo = Object.entries(this.werewolfVotes).map(([voterId, targetId]) => ({
            voterId,
            voterName: this.players[voterId]?.name,
            targetId,
            targetName: this.players[targetId]?.name
        }));
        werewolves.forEach(w => {
            this.io.to(w.id).emit('werewolfVoteUpdate', voteInfo);
        });
    }

    broadcastDayVotes() {
        const voteInfo = Object.entries(this.dayVotes).map(([voterId, targetId]) => ({
            voterId,
            voterName: this.players[voterId]?.name,
            targetId,
            targetName: this.players[targetId]?.name
        }));
        this.io.to(this.roomCode).emit('dayVoteUpdate', voteInfo);
    }

    handleAction(socketId, actionType, targetId) {
        if (!this.players[socketId] || !this.players[socketId].isAlive) return;

        const player = this.players[socketId];

        if (this.state === 'NIGHT') {
            if (socketId === this.sleptThisNightId) {
                this.io.to(socketId).emit('error', 'Bạn đã bị ru ngủ, không thể hành động đêm nay.');
                return;
            }

            if (actionType === 'WEREWOLF_KILL' && this.isWolfAligned(player)) {
                if (player.role === 'WOLF_SEER' && !this.wolfSeerResigned) {
                    this.io.to(socketId).emit('error', 'Sói Tiên Tri phải từ bỏ quyền Soi mới được cắn người.');
                    return;
                }
                if (!this.players[targetId] || this.isWolfAligned(this.players[targetId])) {
                    this.io.to(socketId).emit('error', 'Không thể cắn một thành viên cùng phe sói.');
                    return;
                }
                if (this.werewolfVotes[socketId] === targetId) {
                    delete this.werewolfVotes[socketId];
                } else {
                    this.werewolfVotes[socketId] = targetId;
                }
                this.broadcastWerewolfVotes();
            } else if (actionType === 'AURA_SEER_CHECK' && player.role === 'AURA_SEER') {
                if (player.auraSeerUsedTonight) {
                    this.io.to(socketId).emit('error', 'Bạn đã dùng lượt soi đêm nay rồi.');
                    return;
                }
                const targetRole = this.players[targetId].role;
                let alignment = 'Unknown';
                if (GOOD_ROLES.includes(targetRole)) alignment = 'Good (Dân Làng)';
                else if (this.isWolfAligned(this.players[targetId]) || EVIL_ROLES.includes(targetRole)) alignment = 'Evil (Ma Sói)';
                if (!player.seenAuras) player.seenAuras = {};
                player.seenAuras[targetId] = alignment;
                player.auraSeerUsedTonight = true;
                this.io.to(socketId).emit('systemMessage', `Bạn soi và thấy ${this.players[targetId].name} thuộc phe: ${alignment}.`);
                this.updateClientState();
            } else if (actionType === 'WOLF_SEER_CHECK' && player.role === 'WOLF_SEER') {
                if (this.wolfSeerResigned) {
                    this.io.to(socketId).emit('error', 'Bạn đã từ bỏ quyền Soi!');
                    return;
                }
                if (player.wolfSeerUsedTonight) {
                    this.io.to(socketId).emit('error', 'Bạn đã dùng lượt soi đêm nay rồi.');
                    return;
                }
                const targetRole = this.players[targetId].role;
                if (!player.seenRoles) player.seenRoles = {};
                player.seenRoles[targetId] = targetRole;
                player.wolfSeerUsedTonight = true;
                this.io.to(socketId).emit('systemMessage', `Bạn soi và thấy ${this.players[targetId].name} có vai trò: ${targetRole}.`);
                this.updateClientState();
            } else if (actionType === 'WOLF_SEER_RESIGN' && player.role === 'WOLF_SEER') {
                this.wolfSeerResigned = true;
                this.io.to(socketId).emit('systemMessage', 'Đã từ bỏ quyền Soi. Giờ bạn có thể cắn người!');
            } else if (actionType === 'CURSED_WOLF_TURN' && player.role === 'CURSED_WOLF' && !this.cursedWolfUsed) {
                if (!this.players[targetId] || this.isWolfAligned(this.players[targetId])) {
                    this.io.to(socketId).emit('error', 'Không thể nguyền rủa một thành viên cùng phe sói.');
                    return;
                }
                if (this.cursedWolfTarget === targetId) {
                    this.cursedWolfTarget = null;
                    this.nightActions = this.nightActions.filter(a => a.type !== 'CURSED_WOLF_TURN');
                } else {
                    this.cursedWolfTarget = targetId;
                    this.nightActions = this.nightActions.filter(a => a.type !== 'CURSED_WOLF_TURN');
                    this.nightActions.push({ type: 'CURSED_WOLF_TURN', targetId: targetId, priority: 6 });
                    this.io.to(socketId).emit('systemMessage', `Đã chọn nguyền rủa ${this.players[targetId].name} thành Sói.`);
                }
            } else if (actionType === 'ARSONIST_DOUSE' && player.role === 'ARSONIST') {
                if (this.arsonistDoused.includes(targetId)) {
                    this.io.to(socketId).emit('error', 'Người này đã bị tưới xăng từ trước rồi!');
                    return;
                }
                if (!this.tempArsoTargets[socketId]) this.tempArsoTargets[socketId] = [];
                const targets = this.tempArsoTargets[socketId];
                if (targets.includes(targetId)) {
                    this.tempArsoTargets[socketId] = targets.filter(t => t !== targetId);
                } else {
                    if (targets.length >= 2) {
                        this.io.to(socketId).emit('error', 'Chỉ được tưới xăng tối đa 2 người.');
                        return;
                    }
                    targets.push(targetId);
                }
                this.nightActions = this.nightActions.filter(a => a.socketId !== socketId);
                this.nightActions.push({ type: 'ARSONIST_DOUSE', socketId, targetIds: this.tempArsoTargets[socketId], priority: 1 });
                this.io.to(socketId).emit('systemMessage', `Đã chọn tưới xăng: ${this.tempArsoTargets[socketId].map(id => this.players[id].name).join(', ')}`);
            } else if (actionType === 'ARSONIST_IGNITE' && player.role === 'ARSONIST') {
                if (this.arsonistIgniteUsed) {
                    this.io.to(socketId).emit('error', 'Bạn đã sử dụng mồi lửa duy nhất rồi!');
                    return;
                }
                this.nightActions = this.nightActions.filter(a => a.socketId !== socketId);
                this.nightActions.push({ type: 'ARSONIST_IGNITE', socketId, priority: 5 });
                this.io.to(socketId).emit('systemMessage', 'Đã chọn châm lửa!');
            } else if (actionType === 'DOCTOR_HEAL' && player.role === 'DOCTOR') {
                if (targetId === this.doctorLastHealed) {
                    this.io.to(socketId).emit('systemMessage', 'Bạn không thể cứu người này 2 đêm liên tiếp!');
                    return;
                }
                // Thay thế heal action cũ nếu có (bác sĩ đổi ý)
                this.nightActions = this.nightActions.filter(a => a.type !== 'DOCTOR_HEAL');
                this.nightActions.push({ type: 'DOCTOR_HEAL', targetId: targetId, priority: 1 });
                this.doctorProtectedTargetId = targetId;
                this.updateClientState();
            } else if (actionType === 'WITCH_HEAL' && player.role === 'WITCH' && this.witchHealPotion) {
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
                this.nightActions.push({ type: 'WITCH_HEAL', targetId: targetId, priority: 2 });
            } else if (actionType === 'WITCH_POISON' && player.role === 'WITCH' && this.witchPoisonPotion) {
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
                this.nightActions.push({ type: 'WITCH_POISON', targetId: targetId, priority: 4 });
            } else if (actionType === 'WITCH_NONE' && player.role === 'WITCH') {
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
            }
        } else if (this.state === 'VOTE' && actionType === 'VOTE') {
            if (this.dayVotes[socketId] === targetId) {
                delete this.dayVotes[socketId];
            } else {
                this.dayVotes[socketId] = targetId;
            }
            this.broadcastDayVotes();
        } else if (this.state === 'DAY' && actionType === 'NIGHTMARE_SLEEP' && player.role === 'NIGHTMARE_WEREWOLF') {
            if (this.nightmareSleepCharges > 0) {
                const hadSelectedTarget = !!this.sleepingPlayerId;
                this.sleepingPlayerId = targetId;
                if (!hadSelectedTarget) {
                    this.nightmareSleepCharges--;
                    this.io.to(socketId).emit('systemMessage', `Đã ru ngủ ${this.players[targetId].name} cho đêm tiếp theo. Còn ${this.nightmareSleepCharges} lần.`);
                } else {
                    this.io.to(socketId).emit('systemMessage', `Đã đổi mục tiêu ru ngủ sang ${this.players[targetId].name} cho đêm tiếp theo.`);
                }
                this.updateClientState();
            } else {
                this.io.to(socketId).emit('error', 'Đã hết số lần ru ngủ.');
            }
        } else if (this.state === 'DAY' && actionType === 'PRIEST_WATER' && player.role === 'PRIEST') {
            if (!this.priestUsed) {
                this.priestUsed = true;
                const targetRole = this.players[targetId].role;
                if (this.isWolfAligned(this.players[targetId])) {
                    this.players[targetId].isAlive = false;
                    this.broadcastSystemMessage(`Priest ${player.name} đã tạt nước thánh tiêu diệt sói ${this.players[targetId].name}!`);
                } else {
                    player.isAlive = false;
                    this.broadcastSystemMessage(`Priest ${player.name} đã tạt nhầm nước thánh vào người vô tội và bị trừng phạt!`);
                }
                this.updateClientState();
                this.checkWinCondition();
            } else {
                this.io.to(socketId).emit('error', 'Bạn đã sử dụng nước thánh rồi.');
            }
        }
    }

    resolveNightActions() {
        // Sort actions by priority to make resolution scalable
        this.nightActions.sort((a, b) => a.priority - b.priority);

        let protections = {}; // targetId -> array of protective sources
        let lethalAttacks = []; // array of { targetId, source }
        let newlyDousedTonight = [];
        
        // Reset doctor tracker
        this.doctorLastHealed = null;
        let turnedPlayerId = null;

        for (const action of this.nightActions) {
            if (action.type === 'DOCTOR_HEAL') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('DOCTOR');
                this.doctorLastHealed = action.targetId;
            } else if (action.type === 'WITCH_HEAL') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('WITCH');
                this.witchHealPotion = false;
            } else if (action.type === 'WEREWOLF_KILL') {
                lethalAttacks.push({ targetId: action.targetId, source: 'WEREWOLF' });
            } else if (action.type === 'WITCH_POISON') {
                lethalAttacks.push({ targetId: action.targetId, source: 'WITCH' });
                this.witchPoisonPotion = false;
            } else if (action.type === 'ARSONIST_DOUSE') {
                action.targetIds.forEach(id => {
                    if (!this.arsonistDoused.includes(id)) {
                        this.arsonistDoused.push(id);
                        newlyDousedTonight.push(id);
                    }
                });
            } else if (action.type === 'ARSONIST_IGNITE') {
                this.arsonistDoused.forEach(id => {
                    if (this.players[id] && this.players[id].isAlive) {
                        lethalAttacks.push({ targetId: id, source: 'ARSONIST' });
                    }
                });
                this.arsonistDoused = [];
                this.arsonistIgniteUsed = true;
            } else if (action.type === 'CURSED_WOLF_TURN') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('CURSED_WOLF');
                turnedPlayerId = action.targetId;
                this.cursedWolfUsed = true;
            }
        }

        let deaths = new Set();

        // Evaluate attacks against protections
        for (const attack of lethalAttacks) {
            const targetProtections = protections[attack.targetId] || [];
            
            if (attack.source === 'WEREWOLF') {
                if (this.players[attack.targetId] && this.players[attack.targetId].role === 'ARSONIST') {
                    continue; // Arsonist immune to werewolf kill
                }
                // Werewolf kill blocked by Doctor or Witch heal
                if (targetProtections.includes('DOCTOR') || targetProtections.includes('WITCH') || targetProtections.includes('CURSED_WOLF')) {
                    continue; // Survived
                }
            } else if (attack.source === 'WITCH') {
                // Witch poison ignores Doctor heal (usually), but Witch heal doesn't exist simultaneously with poison for 1 witch
                // However if multiple witches were added later, witch heal might block witch poison.
                if (targetProtections.includes('WITCH')) {
                    continue; // Survived
                }
            }
            // Arsonist ignite goes through everything
            
            deaths.add(attack.targetId);
        }

        deaths.forEach(id => {
            if (this.players[id]) {
                this.players[id].isAlive = false;
                this.io.to(id).emit('systemMessage', 'Bạn đã chết trong đêm qua.');
            }
        });

        this.arsonistDoused = this.arsonistDoused.filter(id => this.players[id] && this.players[id].isAlive);
        this.arsonistNewlyDoused = newlyDousedTonight.filter(id => this.players[id] && this.players[id].isAlive);
        const deathMessages = Array.from(deaths).map(id => this.players[id].name);
        if (deathMessages.length > 0) {
            this.broadcastSystemMessage(`Làng thức dậy. ${deathMessages.join(', ')} đã chết đêm qua.`);
        } else {
            this.broadcastSystemMessage(`Làng thức dậy. Đêm qua bình yên, không có ai chết.`);
        }

        if (!this.checkWinCondition()) {
            if (turnedPlayerId && this.players[turnedPlayerId] && this.players[turnedPlayerId].isAlive && !deaths.has(turnedPlayerId)) {
                this.players[turnedPlayerId].isWolfAligned = true;
                this.io.to(turnedPlayerId).emit('systemMessage', 'Bạn đã bị nguyền rủa. Từ sáng nay bạn theo phe Ma Sói.');
                this.io.to(turnedPlayerId).emit('systemMessage', 'Bạn vẫn giữ vai trò góc và kỹ năng cũ, chỉ đổi sang phe Ma Sói.');
            }
            this.startDay();
        }
    }

    startDay() {
        this.state = 'DAY';
        this.dayVotes = {}; // Clear votes early just in case
        this.sleptThisNightId = null;
        this.doctorProtectedTargetId = null;
        this.updateClientState();
        this.arsonistNewlyDoused.forEach(id => {
            this.io.to(id).emit('systemMessage', 'Sáng nay bạn phát hiện mình đã bị Arsonist tưới xăng từ đêm qua.');
        });
        this.arsonistNewlyDoused = [];
        this.broadcastSystemMessage('Thời gian thảo luận bắt đầu (60s).');
        
        let timeLeft = 60; // 60 seconds for discussion
        this.timer = setInterval(() => {
            timeLeft--;
            this.io.to(this.roomCode).emit('timerUpdate', timeLeft);
            
            if (timeLeft <= 0) {
                clearInterval(this.timer);
                if (!this.checkDiscussionEndWinCondition()) {
                    this.startVote();
                }
            }
        }, 1000);
    }

    checkDiscussionEndWinCondition() {
        const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
        const wolves = alivePlayers.filter(p => this.isWolfAligned(p));
        const nonWolves = alivePlayers.length - wolves.length;

        if (wolves.length > 0 && wolves.length >= nonWolves) {
            this.state = 'GAME_OVER';
            this.updateClientState();
            this.broadcastSystemMessage('Kết thúc thảo luận: phe Sói đã áp đảo toàn bộ phe còn lại. Ma Sói thắng!');
            this.revealAllRoles('WEREWOLF');
            return true;
        }

        return false;
    }

    startVote() {
        this.state = 'VOTE';
        this.dayVotes = {};
        this.updateClientState();
        this.broadcastSystemMessage('Đã đến giờ Bỏ Phiếu (30s). Hãy chọn người bạn muốn treo cổ!');

        let timeLeft = 30; // 30 seconds for voting
        this.timer = setInterval(() => {
            timeLeft--;
            this.io.to(this.roomCode).emit('timerUpdate', timeLeft);
            
            if (timeLeft <= 0) {
                clearInterval(this.timer);
                this.resolveDayVotes();
            }
        }, 1000);
    }

    resolveDayVotes() {
        const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
        const aliveCount = alivePlayers.length;
        const voteCounts = {};
        
        // Count actual votes
        Object.values(this.dayVotes).forEach(targetId => {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        });

        // Calculate skip votes (players who are alive but didn't vote)
        const playersWhoVotedCount = Object.keys(this.dayVotes).length;
        const skipVotes = aliveCount - playersWhoVotedCount;

        let maxVotes = 0;
        let lynchedId = null;
        let tie = false;

        // Find the person with the most votes
        for (const [targetId, votes] of Object.entries(voteCounts)) {
            if (votes > maxVotes) {
                maxVotes = votes;
                lynchedId = targetId;
                tie = false;
            } else if (votes === maxVotes) {
                tie = true;
            }
        }

        // If skipVotes is greater than or equal to maxVotes, no one is lynched
        // Or if there's a tie for the most votes
        if (skipVotes >= maxVotes || tie) {
            lynchedId = null;
        }

        const roleTranslations = {
            'WEREWOLF': 'Ma Sói',
            'SEER': 'Tiên Tri',
            'DOCTOR': 'Bác Sĩ',
            'FOOL': 'Kẻ Ngốc',
            'WITCH': 'Phù Thủy',
            'VILLAGER': 'Dân Làng'
        };

        if (lynchedId) {
            this.players[lynchedId].isAlive = false;
            this.broadcastSystemMessage(`Dân làng đã quyết định treo cổ ${this.players[lynchedId].name}.`);
            this.io.to(lynchedId).emit('systemMessage', 'Bạn đã bị dân làng treo cổ.');
            
            // Kẻ Ngốc win condition
            if (this.players[lynchedId].role === 'FOOL') {
                this.broadcastSystemMessage('Kẻ Ngốc đã bị treo cổ! Kẻ Ngốc đã đánh lừa tất cả mọi người và giành chiến thắng!');
                this.state = 'GAME_OVER';
                this.updateClientState();
                this.revealAllRoles('FOOL');
                return;
            }
        } else {
            this.broadcastSystemMessage(`Dân làng không thể thống nhất quyết định. Không ai bị treo cổ hôm nay.`);
        }

        if (!this.checkWinCondition()) {
            setTimeout(() => {
                this.startNight();
            }, 5000);
        }
    }

    checkWinCondition() {
        const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
        if (alivePlayers.length === 0) return false;

        const wolves = alivePlayers.filter(p => this.isWolfAligned(p));
        const arsonists = alivePlayers.filter(p => p.role === 'ARSONIST');
        const villagers = alivePlayers.filter(p => !this.isWolfAligned(p) && p.role !== 'FOOL' && p.role !== 'ARSONIST');
        
        const nonWolves = alivePlayers.length - wolves.length;
        
        if (arsonists.length > 0 && villagers.length === 0 && wolves.length === 0) {
            this.state = 'GAME_OVER';
            this.updateClientState();
            this.broadcastSystemMessage('Arsonist đã thiêu rụi cả làng! Arsonist Thắng!');
            this.revealAllRoles('ARSONIST');
            return true;
        } else if (wolves.length >= nonWolves && arsonists.length === 0) {
            this.state = 'GAME_OVER';
            this.updateClientState();
            this.broadcastSystemMessage('Ma Sói đã chiếm ưu thế! Ma Sói Thắng!');
            this.revealAllRoles('WEREWOLF');
            return true;
        } else if (wolves.length === 0 && arsonists.length === 0) {
            this.state = 'GAME_OVER';
            this.updateClientState();
            this.broadcastSystemMessage('Sói và Kẻ xấu đã bị tiêu diệt! Dân Làng Thắng!');
            this.revealAllRoles('VILLAGER');
            return true;
        }

        return false;
    }

    revealAllRoles(winnerTeam) {
        const allRoles = Object.values(this.players).map(p => ({
            name: p.name,
            role: p.role
        }));
        this.io.to(this.roomCode).emit('gameOver', { winnerTeam: winnerTeam, roles: allRoles });

        // Auto reset to lobby after 5 seconds
        setTimeout(() => {
            if (this.state === 'GAME_OVER') {
                this.resetGame();
            }
        }, 10000);
    }

    resetGame() {
        this.state = 'LOBBY';
        this.dayNumber = 0;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.nightTimer) { clearInterval(this.nightTimer); this.nightTimer = null; }
        this.nightActions = [];
        this.dayVotes = {};
        this.werewolfVotes = {};
        this.witchHealPotion = true;
        this.witchPoisonPotion = true;
        this.doctorLastHealed = null;

        this.nightmareSleepCharges = 2;
        this.sleepingPlayerId = null;
        this.sleptThisNightId = null;
        this.arsonistDoused = [];
        this.arsonistNewlyDoused = [];
        this.priestUsed = false;
        this.wolfSeerResigned = false;
        this.cursedWolfUsed = false;
        this.cursedWolfTarget = null;
        this.arsonistIgniteUsed = false;
        this.tempArsoTargets = {};

        Object.values(this.players).forEach(p => {
            p.role = null;
            p.isWolfAligned = false;
            p.isAlive = true;
            p.seenRoles = {};
            p.seenAuras = {};
            p.auraSeerUsedTonight = false;
            p.wolfSeerUsedTonight = false;
        });

        this.io.to(this.roomCode).emit('gameReset');
    }

    handleChat(socketId, message) {
        const player = this.players[socketId];
        if (!player) return;

        const chatMsg = {
            senderId: socketId,
            sender: player.name,
            message: message,
            isGhost: !player.isAlive,
            isWerewolfChannel: false
        };

        if (!player.isAlive) {
            // Ghost chat - only send to other dead players
            for (const id in this.players) {
                if (!this.players[id].isAlive) {
                    this.io.to(id).emit('chatMessage', chatMsg);
                }
            }
        } else if (this.state === 'NIGHT') {
            // If night, only werewolves can chat (in werewolf channel)
            if (this.isWolfAligned(player)) {
                chatMsg.isWerewolfChannel = true;
                for (const id in this.players) {
                    if (this.isWolfAligned(this.players[id]) && this.players[id].isAlive) {
                        this.io.to(id).emit('chatMessage', chatMsg);
                    }
                }
            } else {
                // Non-werewolves cannot chat at night
                this.io.to(socketId).emit('systemMessage', 'Bạn không thể nói chuyện vào ban đêm.');
            }
        } else {
            // Day chat - everyone alive can see, dead can see too but their msgs don't go here
            this.io.to(this.roomCode).emit('chatMessage', chatMsg);
        }
    }

    broadcastSystemMessage(message) {
        this.io.to(this.roomCode).emit('systemMessage', message);
    }

    updateClientState() {
        for (const socketId in this.players) {
            const stateForPlayer = {
                state: this.state,
                dayNumber: this.dayNumber,
                players: this.getPlayers(socketId),
                player: { 
                    ...this.players[socketId],
                    witchHealPotion: this.witchHealPotion,
                    witchPoisonPotion: this.witchPoisonPotion,
                    doctorLastHealed: this.doctorLastHealed,
                    doctorProtectedTargetId: this.players[socketId].role === 'DOCTOR' ? this.doctorProtectedTargetId : null,
                    canWerewolfKill: this.isWolfAligned(this.players[socketId]),
                    cursedWolfUsed: this.cursedWolfUsed,
                    arsonistDoused: this.players[socketId].role === 'ARSONIST' ? this.arsonistDoused : [],
                    arsonistIgniteUsed: this.players[socketId].role === 'ARSONIST' ? this.arsonistIgniteUsed : false,
                    sleepingPlayerId: this.players[socketId].role === 'NIGHTMARE_WEREWOLF' ? this.sleepingPlayerId : null,
                    sleptThisNightId: this.players[socketId].role === 'NIGHTMARE_WEREWOLF' ? this.sleptThisNightId : null,
                    auraSeerUsedTonight: this.players[socketId].role === 'AURA_SEER' ? this.players[socketId].auraSeerUsedTonight : false,
                    wolfSeerUsedTonight: this.players[socketId].role === 'WOLF_SEER' ? this.players[socketId].wolfSeerUsedTonight : false,
                    cursedWolfTarget: this.players[socketId].role === 'CURSED_WOLF' ? this.cursedWolfTarget : null,
                    currentWerewolfVote: this.werewolfVotes ? (this.werewolfVotes[socketId] || null) : null
                }
            };
            this.io.to(socketId).emit('gameStateUpdate', stateForPlayer);
        }
    }
}

module.exports = GameLogic;
