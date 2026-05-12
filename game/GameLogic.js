const RoleRegistry = require('../shared/roleRegistry');

const EVIL_ROLES = RoleRegistry.evilRoleIds;
const GOOD_ROLES = RoleRegistry.goodRoleIds;

function sanitizeAvatarUrl(url) {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return trimmed;
    } catch {
        return null;
    }
}

function shuffleArray(items) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

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
        this.doctorSavedTargetIds = [];
        this.revealRoleOnDeath = true; // setting: show role when player dies
        this.showDeathCause = false; // setting: show why a dead player died
        this.anonymousMatch = false; // setting: hide names/avatars in game UI
        this.settings = {
            revealRoleOnDeath: true,
            showDeathCause: false,
            anonymousMatch: false,
            roles: {}
        };
        this.nextPlayerIndex = 1;
        this.playerOrder = [];
        
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
        this.redLadyVisitTargets = {};
        this.maidProtectedTargetIds = {};
        this.jailerSelectedTargetIds = {};
        this.jailerJailedTargetIds = {};
        this.sheriffWatchTargetIds = {};
        this.flowerChildProtectedTargetIds = {};
        this.guardianWolfProtectedTargetIds = {};
        this.actionLog = [];
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

    isSoloKiller(player) {
        return !!player && player.role === 'ARSONIST';
    }

    canAvengerTrigger() {
        return this.dayNumber > 1 || (this.dayNumber === 1 && this.state !== 'NIGHT');
    }

    getDayVoteWeight(player) {
        return player && player.role === 'MAYOR' && player.publiclyRevealedRole ? 2 : 1;
    }

    getJailerIdForJailedTarget(targetId) {
        return Object.entries(this.jailerJailedTargetIds || {}).find(([, jailedId]) => jailedId === targetId)?.[0] || null;
    }

    getJailTargetForParticipant(socketId) {
        if (this.jailerJailedTargetIds && this.jailerJailedTargetIds[socketId]) {
            return { jailerId: socketId, jailedId: this.jailerJailedTargetIds[socketId] };
        }

        const jailerId = this.getJailerIdForJailedTarget(socketId);
        return jailerId ? { jailerId, jailedId: socketId } : null;
    }

    isJailedPlayer(socketId) {
        return !!this.getJailerIdForJailedTarget(socketId);
    }

    getAlivePlayersExcept(excludedIds = []) {
        const excluded = new Set(excludedIds.filter(Boolean));
        return Object.values(this.players).filter(p => p.isAlive && !excluded.has(p.id));
    }

    getWerewolfKillerCandidate(targetId) {
        const voters = Object.entries(this.werewolfVotes || {})
            .filter(([, votedTargetId]) => votedTargetId === targetId)
            .map(([voterId]) => this.players[voterId])
            .filter(p => p && this.isWolfAligned(p));

        if (voters.length > 0) return voters[Math.floor(Math.random() * voters.length)].id;

        const wolves = Object.values(this.players).filter(p => p.isAlive && this.isWolfAligned(p));
        return wolves.length > 0 ? wolves[Math.floor(Math.random() * wolves.length)].id : null;
    }

    buildSheriffSuspects(sheriffId, victimId, killerId) {
        const suspects = [];
        if (killerId && this.players[killerId] && killerId !== sheriffId && killerId !== victimId) {
            suspects.push(killerId);
        }

        const fillers = shuffleArray(this.getAlivePlayersExcept([sheriffId, victimId, ...suspects]))
            .map(p => p.id);

        while (suspects.length < 2 && fillers.length > 0) {
            suspects.push(fillers.shift());
        }

        return suspects;
    }

    notifySheriffResults(deaths, nightDeathEvidence) {
        Object.entries(this.sheriffWatchTargetIds || {}).forEach(([sheriffId, watchedIds]) => {
            const sheriff = this.players[sheriffId];
            if (!sheriff || !sheriff.isAlive || sheriff.role !== 'SHERIFF') return;

            (watchedIds || []).forEach(targetId => {
                if (!deaths.has(targetId)) return;

                const target = this.players[targetId];
                const evidence = nightDeathEvidence.get(targetId);
                if (!evidence || !evidence.direct) {
                    this.io.to(sheriffId).emit('systemMessage', `${target?.name || 'Mục tiêu'} đã chết trong đêm, nhưng đây không phải cái chết trực tiếp nên bạn không tìm được nghi phạm.`);
                    return;
                }

                const suspectIds = this.buildSheriffSuspects(sheriffId, targetId, evidence.killerId);
                if (suspectIds.length === 0) {
                    this.io.to(sheriffId).emit('systemMessage', `${target?.name || 'Mục tiêu'} đã chết trong đêm, nhưng bạn không tìm được nghi phạm phù hợp.`);
                    return;
                }

                const suspectNames = suspectIds.map(id => this.players[id]?.name).filter(Boolean).join(', ');
                this.io.to(sheriffId).emit('systemMessage', `Cảnh Sát Trưởng: ${target.name} đã chết. Nghi phạm có thể là: ${suspectNames}.`);
            });
        });
    }

    getPlayerIdsInDisplayOrder() {
        const currentIds = Object.keys(this.players);
        if (this.state === 'LOBBY' || this.playerOrder.length === 0) return currentIds;

        const currentIdSet = new Set(currentIds);
        const orderedIds = this.playerOrder.filter(id => currentIdSet.has(id));
        const missingIds = currentIds.filter(id => !orderedIds.includes(id));
        return [...orderedIds, ...missingIds];
    }

    addPlayer(socketId, name, isHost, avatarUrl = null) {
        this.players[socketId] = {
            id: socketId,
            playerIndex: this.nextPlayerIndex++,
            name: name,
            avatarUrl: sanitizeAvatarUrl(avatarUrl),
            isHost: isHost,
            role: null,
            isWolfAligned: false,
            isAlive: true,
            seenRoles: {}, // targetId -> roleName
            seenAuras: {}, // targetId -> Good | Evil | Unknown
            auraSeerUsedTonight: false,
            wolfSeerUsedTonight: false,
            loudmouthTargetId: null,
            avengerTargetId: null,
            jailerBullet: true,
            flowerChildUsed: false,
            flowerChildProtectedTargetId: null,
            guardianWolfUsed: false,
            guardianWolfProtectedTargetId: null,
            publiclyRevealedRole: false,
            deathCause: null
        };
        return this.players[socketId];
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        delete this.dayVotes[socketId];
        delete this.werewolfVotes?.[socketId];
        delete this.jailerSelectedTargetIds[socketId];
        delete this.jailerJailedTargetIds[socketId];
        delete this.sheriffWatchTargetIds[socketId];
        delete this.flowerChildProtectedTargetIds[socketId];
        delete this.guardianWolfProtectedTargetIds[socketId];
        Object.keys(this.jailerSelectedTargetIds).forEach(jailerId => {
            if (this.jailerSelectedTargetIds[jailerId] === socketId) delete this.jailerSelectedTargetIds[jailerId];
        });
        Object.keys(this.jailerJailedTargetIds).forEach(jailerId => {
            if (this.jailerJailedTargetIds[jailerId] === socketId) delete this.jailerJailedTargetIds[jailerId];
        });
        Object.keys(this.sheriffWatchTargetIds).forEach(sheriffId => {
            this.sheriffWatchTargetIds[sheriffId] = this.sheriffWatchTargetIds[sheriffId].filter(id => id !== socketId);
        });
        Object.keys(this.flowerChildProtectedTargetIds).forEach(flowerChildId => {
            if (this.flowerChildProtectedTargetIds[flowerChildId] === socketId) delete this.flowerChildProtectedTargetIds[flowerChildId];
        });
        Object.keys(this.guardianWolfProtectedTargetIds).forEach(guardianId => {
            if (this.guardianWolfProtectedTargetIds[guardianId] === socketId) delete this.guardianWolfProtectedTargetIds[guardianId];
        });
        this.playerOrder = this.playerOrder.filter(id => id !== socketId);
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
        
        return this.getPlayerIdsInDisplayOrder().map(id => this.players[id]).filter(Boolean).map((p, index) => {
            if (this.state !== 'LOBBY') {
                p.playerIndex = index + 1;
            }

            let reveal = false;
            if (p.id === forSocketId) reveal = true;
            if (p.publiclyRevealedRole) reveal = true;
            if (this.state === 'GAME_OVER' || (!p.isAlive && this.revealRoleOnDeath)) reveal = true;
            if (this.canWolfTeamRevealRole(forPlayer, p)) reveal = true;
            
            return {
                id: p.id,
                playerIndex: p.playerIndex,
                name: p.name,
                avatarUrl: p.avatarUrl || null,
                isHost: p.isHost,
                isAlive: p.isAlive,
                role: (reveal || (forPlayer && forPlayer.seenRoles && forPlayer.seenRoles[p.id])) ? p.role : null,
                deathCause: (!p.isAlive && this.showDeathCause) ? p.deathCause : null,
                doctorSavedLastNight: this.doctorSavedTargetIds.includes(p.id),
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
            showDeathCause: false,
            anonymousMatch: false,
            roles: { villager: playerCount - 1, werewolf: 1 } 
        };

        // Save game settings
        this.revealRoleOnDeath = settings.revealRoleOnDeath !== false;
        this.showDeathCause = settings.showDeathCause === true;
        this.anonymousMatch = settings.anonymousMatch === true;
        this.settings = {
            ...settings,
            revealRoleOnDeath: this.revealRoleOnDeath,
            showDeathCause: this.showDeathCause,
            anonymousMatch: this.anonymousMatch,
            roles: settings.roles || {}
        };

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

        this.actionLog = [];
        this.playerOrder = shuffleArray(Object.keys(this.players));
        this.assignRoles(settings);
        this.addActionLog(`Trò chơi bắt đầu với ${playerCount} người chơi.`, 'Bắt đầu');
        this.state = 'ROLE_REVEAL';
        this.updateClientState();

        for (const socketId in this.players) {
            this.io.to(socketId).emit('roleAssigned', this.players[socketId].role);
        }

        this.broadcastSystemMessage('Trò chơi đã bắt đầu. Hãy kiểm tra vai trò của bạn.');
        setTimeout(() => this.startNight(), 5000);
    }

    assignRoles(settings) {
        const ids = shuffleArray(Object.keys(this.players));

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

    getRoleName(roleId) {
        return RoleRegistry.get(roleId)?.name || roleId || 'Không rõ';
    }

    getPlayerLabel(playerOrId) {
        const player = typeof playerOrId === 'string' ? this.players[playerOrId] : playerOrId;
        if (!player) return 'Không rõ';
        return `${this.getRoleName(player.role)} ${player.name}`;
    }

    getLogPhase() {
        if (this.state === 'NIGHT') return `Đêm ${this.dayNumber}`;
        if (this.state === 'DAY' || this.state === 'VOTE') return `Ngày ${this.dayNumber}`;
        return 'Diễn biến';
    }

    addActionLog(text, phase = this.getLogPhase(), importance = 'main') {
        if (!text) return;
        this.actionLog.push({ phase, text, time: Date.now(), importance });
    }

    getPublicActionLog() {
        return this.actionLog.filter(entry => entry.importance !== 'detail');
    }

    broadcastRoleActionSfx(type) {
        if (!type || this.state !== 'NIGHT') return;
        this.io.to(this.roomCode).emit('roleActionSfx', { type });
    }

    activateJailsForNight() {
        const activeJails = {};

        Object.entries(this.jailerSelectedTargetIds || {}).forEach(([jailerId, targetId]) => {
            const jailer = this.players[jailerId];
            const target = this.players[targetId];
            if (!jailer || !target || jailer.role !== 'JAILER' || !jailer.isAlive || !target.isAlive || jailerId === targetId) return;
            activeJails[jailerId] = targetId;
        });

        const jailedTargetIds = new Set(Object.values(activeJails));
        Object.keys(activeJails).forEach(jailerId => {
            if (jailedTargetIds.has(jailerId)) delete activeJails[jailerId];
        });

        this.jailerJailedTargetIds = activeJails;
        this.jailerSelectedTargetIds = {};

        Object.entries(this.jailerJailedTargetIds).forEach(([jailerId, targetId]) => {
            const jailer = this.players[jailerId];
            const target = this.players[targetId];
            if (!jailer || !target) return;

            this.addActionLog(`${this.getPlayerLabel(jailer)} giam ${this.getPlayerLabel(target)} trong đêm.`, undefined, 'detail');
            this.io.to(jailerId).emit('systemMessage', `${target.name} đã bị đưa vào nhà giam. Bạn có thể nói chuyện ẩn danh trong tab Nhà Giam${jailer.jailerBullet ? ' và có thể xử tử người này' : ''}.`);
            this.io.to(targetId).emit('systemMessage', 'Bạn đã bị Giám Ngục giam. Đêm nay bạn không thể dùng kỹ năng, không thể bị tấn công và có thể nói chuyện ẩn danh trong tab Nhà Giam.');
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
        this.doctorSavedTargetIds = [];
        this.redLadyVisitTargets = {};
        this.maidProtectedTargetIds = {};
        this.jailerJailedTargetIds = {};
        this.sheriffWatchTargetIds = {};
        this.flowerChildProtectedTargetIds = {};
        this.guardianWolfProtectedTargetIds = {};
        this.activateJailsForNight();
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
            if (p.role === 'JAILER' && !this.jailerJailedTargetIds[p.id]) return;
            if (p.isAlive && this.hasNightAction(p) && p.id !== this.sleptThisNightId && !this.isJailedPlayer(p.id)) {
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
                    this.addActionLog(`Bầy sói chọn giết ${this.getPlayerLabel(target)}.`);
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
            voteWeight: this.getDayVoteWeight(this.players[voterId]),
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

            if (this.isJailedPlayer(socketId)) {
                this.io.to(socketId).emit('error', 'Bạn đang bị giam, không thể hành động đêm nay.');
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
                if (this.isJailedPlayer(targetId)) {
                    this.io.to(socketId).emit('error', 'Người này đang bị giam và không thể bị tấn công.');
                    return;
                }
                if (this.werewolfVotes[socketId] === targetId) {
                    this.addActionLog(`${this.getPlayerLabel(player)} bỏ vote giết ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                    delete this.werewolfVotes[socketId];
                } else {
                    this.werewolfVotes[socketId] = targetId;
                    this.addActionLog(`${this.getPlayerLabel(player)} vote giết ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
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
                this.addActionLog(`${this.getPlayerLabel(player)} soi hào quang ${this.getPlayerLabel(targetId)} và thấy ${alignment}.`, undefined, 'detail');
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
                this.addActionLog(`${this.getPlayerLabel(player)} soi vai trò ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Bạn soi và thấy ${this.players[targetId].name} có vai trò: ${targetRole}.`);
                this.updateClientState();
            } else if (actionType === 'WOLF_SEER_RESIGN' && player.role === 'WOLF_SEER') {
                this.wolfSeerResigned = true;
                this.addActionLog(`${this.getPlayerLabel(player)} từ bỏ quyền soi để tham gia cắn.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', 'Đã từ bỏ quyền Soi. Giờ bạn có thể cắn người!');
            } else if (actionType === 'CURSED_WOLF_TURN' && player.role === 'CURSED_WOLF' && !this.cursedWolfUsed) {
                if (!this.players[targetId] || this.isWolfAligned(this.players[targetId])) {
                    this.io.to(socketId).emit('error', 'Không thể nguyền rủa một thành viên cùng phe sói.');
                    return;
                }
                if (this.cursedWolfTarget === targetId) {
                    this.addActionLog(`${this.getPlayerLabel(player)} hủy nguyền rủa ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                    this.cursedWolfTarget = null;
                    this.nightActions = this.nightActions.filter(a => a.type !== 'CURSED_WOLF_TURN');
                } else {
                    this.cursedWolfTarget = targetId;
                    this.nightActions = this.nightActions.filter(a => a.type !== 'CURSED_WOLF_TURN');
                    this.nightActions.push({ type: 'CURSED_WOLF_TURN', targetId: targetId, priority: 6 });
                    this.addActionLog(`${this.getPlayerLabel(player)} chọn nguyền rủa ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
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
                this.addActionLog(`${this.getPlayerLabel(player)} chọn tưới xăng: ${this.tempArsoTargets[socketId].map(id => this.getPlayerLabel(id)).join(', ') || 'không ai'}.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Đã chọn tưới xăng: ${this.tempArsoTargets[socketId].map(id => this.players[id].name).join(', ')}`);
            } else if (actionType === 'ARSONIST_IGNITE' && player.role === 'ARSONIST') {
                if (this.arsonistIgniteUsed) {
                    this.io.to(socketId).emit('error', 'Bạn đã sử dụng mồi lửa duy nhất rồi!');
                    return;
                }
                this.nightActions = this.nightActions.filter(a => a.socketId !== socketId);
                this.nightActions.push({ type: 'ARSONIST_IGNITE', socketId, priority: 5 });
                this.addActionLog(`${this.getPlayerLabel(player)} chọn châm lửa.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', 'Đã chọn châm lửa!');
            } else if (actionType === 'DOCTOR_HEAL' && player.role === 'DOCTOR') {
                if (!this.players[targetId] || !this.players[targetId].isAlive) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống để bảo vệ.');
                    return;
                }
                if (targetId === this.doctorLastHealed) {
                    this.io.to(socketId).emit('systemMessage', 'Bạn không thể cứu người này 2 đêm liên tiếp!');
                    return;
                }
                // Thay thế heal action cũ nếu có (bác sĩ đổi ý)
                this.nightActions = this.nightActions.filter(a => a.type !== 'DOCTOR_HEAL');
                this.nightActions.push({ type: 'DOCTOR_HEAL', targetId: targetId, priority: 1 });
                this.doctorProtectedTargetId = targetId;
                this.addActionLog(`${this.getPlayerLabel(player)} bảo vệ ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.broadcastRoleActionSfx('doctorProtect');
                this.updateClientState();
            } else if (actionType === 'RED_LADY_VISIT' && player.role === 'RED_LADY') {
                if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để ghé thăm.');
                    return;
                }
                this.redLadyVisitTargets[socketId] = targetId;
                this.nightActions = this.nightActions.filter(a => a.type !== 'RED_LADY_VISIT' || a.socketId !== socketId);
                this.nightActions.push({ type: 'RED_LADY_VISIT', socketId, targetId, priority: 1 });
                this.addActionLog(`${this.getPlayerLabel(player)} ghé thăm ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Đã chọn ghé thăm ${this.players[targetId].name} đêm nay.`);
                this.updateClientState();
            } else if (actionType === 'LOUDMOUTH_SELECT' && player.role === 'LOUDMOUTH') {
                if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác.');
                    return;
                }
                player.loudmouthTargetId = targetId;
                this.addActionLog(`${this.getPlayerLabel(player)} chọn ${this.getPlayerLabel(targetId)} để lộ vai trò khi chết.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Khi bạn chết, vai trò của ${this.players[targetId].name} sẽ bị tiết lộ.`);
                this.updateClientState();
            } else if (actionType === 'MAID_PROTECT' && player.role === 'MAID') {
                if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để bảo vệ.');
                    return;
                }
                this.maidProtectedTargetIds[socketId] = targetId;
                this.nightActions = this.nightActions.filter(a => a.type !== 'MAID_PROTECT' || a.socketId !== socketId);
                this.nightActions.push({ type: 'MAID_PROTECT', socketId, targetId, priority: 1 });
                this.addActionLog(`${this.getPlayerLabel(player)} bảo vệ ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.broadcastRoleActionSfx('maidProtect');
                this.io.to(socketId).emit('systemMessage', `Đã chọn bảo vệ ${this.players[targetId].name} đêm nay.`);
                this.updateClientState();
            } else if (actionType === 'AVENGER_SELECT' && player.role === 'AVENGER') {
                if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác làm mục tiêu báo thù.');
                    return;
                }
                player.avengerTargetId = targetId;
                this.addActionLog(`${this.getPlayerLabel(player)} chọn ${this.getPlayerLabel(targetId)} làm mục tiêu báo thù.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Đã chọn ${this.players[targetId].name} làm mục tiêu báo thù.`);
                this.updateClientState();
            } else if (actionType === 'SHERIFF_WATCH' && player.role === 'SHERIFF') {
                if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                    this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để theo dõi.');
                    return;
                }
                if (!this.sheriffWatchTargetIds[socketId]) this.sheriffWatchTargetIds[socketId] = [];
                const targets = this.sheriffWatchTargetIds[socketId];
                if (targets.includes(targetId)) {
                    this.sheriffWatchTargetIds[socketId] = targets.filter(id => id !== targetId);
                } else {
                    if (targets.length >= 2) {
                        this.io.to(socketId).emit('error', 'Cảnh Sát Trưởng chỉ được theo dõi tối đa 2 người mỗi đêm.');
                        return;
                    }
                    targets.push(targetId);
                }
                this.addActionLog(`${this.getPlayerLabel(player)} theo dõi: ${this.sheriffWatchTargetIds[socketId].map(id => this.getPlayerLabel(id)).join(', ') || 'không ai'}.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Đã chọn theo dõi: ${this.sheriffWatchTargetIds[socketId].map(id => this.players[id].name).join(', ') || 'không ai'}.`);
                this.updateClientState();
            } else if (actionType === 'JAILER_EXECUTE' && player.role === 'JAILER') {
                const jailedTargetId = this.jailerJailedTargetIds[socketId];
                if (!jailedTargetId || jailedTargetId !== targetId || !this.players[targetId] || !this.players[targetId].isAlive) {
                    this.io.to(socketId).emit('error', 'Bạn chỉ có thể xử tử người đang bị bạn giam trong đêm nay.');
                    return;
                }
                if (!player.jailerBullet) {
                    this.io.to(socketId).emit('error', 'Bạn đã dùng viên đạn duy nhất của Giám Ngục.');
                    return;
                }
                player.jailerBullet = false;
                this.nightActions = this.nightActions.filter(a => a.type !== 'JAILER_EXECUTE' || a.socketId !== socketId);
                this.nightActions.push({ type: 'JAILER_EXECUTE', socketId, targetId, priority: 4 });
                this.addActionLog(`${this.getPlayerLabel(player)} quyết định xử tử ${this.getPlayerLabel(targetId)} trong nhà giam.`, undefined, 'detail');
                this.io.to(socketId).emit('systemMessage', `Đã quyết định xử tử ${this.players[targetId].name}.`);
                this.updateClientState();
            } else if (actionType === 'WITCH_HEAL' && player.role === 'WITCH' && this.witchHealPotion) {
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
                this.nightActions.push({ type: 'WITCH_HEAL', targetId: targetId, priority: 2 });
                this.addActionLog(`${this.getPlayerLabel(player)} chọn cứu ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.broadcastRoleActionSfx('witchHeal');
            } else if (actionType === 'WITCH_POISON' && player.role === 'WITCH' && this.witchPoisonPotion) {
                if (this.isJailedPlayer(targetId)) {
                    this.io.to(socketId).emit('error', 'Người này đang bị giam và không thể bị tấn công.');
                    return;
                }
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
                this.nightActions.push({ type: 'WITCH_POISON', socketId, targetId: targetId, priority: 4 });
                this.addActionLog(`${this.getPlayerLabel(player)} chọn đầu độc ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                this.broadcastRoleActionSfx('witchPoison');
            } else if (actionType === 'WITCH_NONE' && player.role === 'WITCH') {
                this.nightActions = this.nightActions.filter(a => !a.type.startsWith('WITCH_'));
                this.addActionLog(`${this.getPlayerLabel(player)} bỏ qua lượt dùng thuốc.`, undefined, 'detail');
            }
        } else if (this.state === 'VOTE' && actionType === 'VOTE') {
            if (this.dayVotes[socketId] === targetId) {
                this.addActionLog(`${this.getPlayerLabel(player)} bỏ phiếu treo cổ ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
                delete this.dayVotes[socketId];
            } else {
                this.dayVotes[socketId] = targetId;
                this.addActionLog(`${this.getPlayerLabel(player)} vote treo cổ ${this.getPlayerLabel(targetId)}.`, undefined, 'detail');
            }
            this.broadcastDayVotes();
        } else if ((this.state === 'DAY' || this.state === 'VOTE') && actionType === 'MAYOR_REVEAL' && player.role === 'MAYOR') {
            if (targetId !== socketId) {
                this.io.to(socketId).emit('error', 'Thị Trưởng chỉ có thể tự lộ vai trò của mình.');
                return;
            }
            if (player.publiclyRevealedRole) {
                this.io.to(socketId).emit('error', 'Bạn đã lộ vai trò Thị Trưởng rồi.');
                return;
            }
            player.publiclyRevealedRole = true;
            this.addActionLog(`${this.getPlayerLabel(player)} tự lộ vai trò Thị Trưởng. Phiếu treo cổ của họ từ giờ được tính x2.`);
            this.broadcastSystemMessage(`Thị Trưởng ${player.name} đã lộ diện. Từ giờ phiếu treo cổ của họ được tính là 2 phiếu.`);
            this.updateClientState();
            this.broadcastDayVotes();
        } else if ((this.state === 'DAY' || this.state === 'VOTE') && actionType === 'JAILER_SELECT' && player.role === 'JAILER') {
            if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để giam đêm tới.');
                return;
            }
            this.jailerSelectedTargetIds[socketId] = targetId;
            this.addActionLog(`${this.getPlayerLabel(player)} chọn giam ${this.getPlayerLabel(targetId)} vào đêm kế tiếp.`, undefined, 'detail');
            this.io.to(socketId).emit('systemMessage', `Đã chọn ${this.players[targetId].name} để giam vào đêm kế tiếp.`);
            this.updateClientState();
        } else if ((this.state === 'DAY' || this.state === 'VOTE') && actionType === 'FLOWER_CHILD_PROTECT' && player.role === 'FLOWER_CHILD') {
            if (player.flowerChildUsed) {
                this.io.to(socketId).emit('error', 'Bạn đã dùng quyền bảo vệ khỏi treo cổ rồi.');
                return;
            }
            if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để bảo vệ khỏi treo cổ.');
                return;
            }
            player.flowerChildUsed = true;
            player.flowerChildProtectedTargetId = targetId;
            this.flowerChildProtectedTargetIds[socketId] = targetId;
            this.addActionLog(`${this.getPlayerLabel(player)} bảo vệ ${this.getPlayerLabel(targetId)} khỏi bị treo cổ hôm nay.`);
            this.io.to(socketId).emit('systemMessage', `Đã bảo vệ ${this.players[targetId].name} khỏi bị treo cổ trong ngày hôm nay.`);
            this.updateClientState();
        } else if ((this.state === 'DAY' || this.state === 'VOTE') && actionType === 'GUARDIAN_WOLF_PROTECT' && player.role === 'GUARDIAN_WOLF') {
            if (player.guardianWolfUsed) {
                this.io.to(socketId).emit('error', 'Bạn đã dùng quyền bảo vệ khỏi treo cổ rồi.');
                return;
            }
            if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác để bảo vệ khỏi treo cổ.');
                return;
            }
            player.guardianWolfProtectedTargetId = targetId;
            this.guardianWolfProtectedTargetIds[socketId] = targetId;
            this.addActionLog(`${this.getPlayerLabel(player)} chọn bảo vệ ${this.getPlayerLabel(targetId)} khỏi bị treo cổ hôm nay.`, undefined, 'detail');
            this.io.to(socketId).emit('systemMessage', `Đã chọn bảo vệ ${this.players[targetId].name} khỏi bị treo cổ trong ngày hôm nay. Kỹ năng chỉ mất nếu bảo vệ thành công.`);
            this.updateClientState();
        } else if ((this.state === 'DAY' || this.state === 'VOTE') && actionType === 'AVENGER_SELECT' && player.role === 'AVENGER') {
            if (!this.players[targetId] || !this.players[targetId].isAlive || targetId === socketId) {
                this.io.to(socketId).emit('error', 'Bạn phải chọn một người chơi còn sống khác làm mục tiêu báo thù.');
                return;
            }
            player.avengerTargetId = targetId;
            this.addActionLog(`${this.getPlayerLabel(player)} chọn ${this.getPlayerLabel(targetId)} làm mục tiêu báo thù.`, undefined, 'detail');
            this.io.to(socketId).emit('systemMessage', `Đã chọn ${this.players[targetId].name} làm mục tiêu báo thù.`);
            this.updateClientState();
        } else if (this.state === 'DAY' && actionType === 'NIGHTMARE_SLEEP' && player.role === 'NIGHTMARE_WEREWOLF') {
            if (this.nightmareSleepCharges > 0) {
                const hadSelectedTarget = !!this.sleepingPlayerId;
                this.sleepingPlayerId = targetId;
                if (!hadSelectedTarget) {
                    this.nightmareSleepCharges--;
                    this.addActionLog(`${this.getPlayerLabel(player)} ru ngủ ${this.getPlayerLabel(targetId)} cho đêm tiếp theo.`);
                    this.io.to(socketId).emit('systemMessage', `Đã ru ngủ ${this.players[targetId].name} cho đêm tiếp theo. Còn ${this.nightmareSleepCharges} lần.`);
                } else {
                    this.addActionLog(`${this.getPlayerLabel(player)} đổi mục tiêu ru ngủ sang ${this.getPlayerLabel(targetId)}.`);
                    this.io.to(socketId).emit('systemMessage', `Đã đổi mục tiêu ru ngủ sang ${this.players[targetId].name} cho đêm tiếp theo.`);
                }
                this.updateClientState();
            } else {
                this.io.to(socketId).emit('error', 'Đã hết số lần ru ngủ.');
            }
        } else if (this.state === 'DAY' && actionType === 'PRIEST_WATER' && player.role === 'PRIEST') {
            if (!this.priestUsed) {
                this.priestUsed = true;
                if (this.isWolfAligned(this.players[targetId])) {
                    const deaths = this.applyDeaths([{ id: targetId, cause: 'bị Linh Mục tạt nước thánh' }]);
                    this.addActionLog(`${this.getPlayerLabel(player)} tạt nước thánh trúng ${this.getPlayerLabel(targetId)}.`);
                    this.broadcastSystemMessage(`Priest ${player.name} đã tạt nước thánh tiêu diệt sói ${this.players[targetId].name}!`);
                    deaths.forEach(id => this.io.to(id).emit('systemMessage', 'Bạn đã chết vì nước thánh hoặc báo thù.'));
                } else {
                    const deaths = this.applyDeaths([{ id: socketId, cause: 'bị trừng phạt vì tạt nhầm nước thánh' }]);
                    this.addActionLog(`${this.getPlayerLabel(player)} tạt nước thánh nhầm ${this.getPlayerLabel(targetId)} và tự chết.`);
                    this.broadcastSystemMessage(`Priest ${player.name} đã tạt nhầm nước thánh vào người vô tội và bị trừng phạt!`);
                    deaths.forEach(id => this.io.to(id).emit('systemMessage', 'Bạn đã chết vì nước thánh hoặc báo thù.'));
                }
                this.updateClientState();
                this.checkWinCondition();
            } else {
                this.io.to(socketId).emit('error', 'Bạn đã sử dụng nước thánh rồi.');
            }
        }
    }

    createDeathEntry(rawDeath, fallbackCause) {
        if (rawDeath && typeof rawDeath === 'object') {
            return {
                id: rawDeath.id || rawDeath.targetId,
                cause: rawDeath.cause || fallbackCause
            };
        }

        return { id: rawDeath, cause: fallbackCause };
    }

    isDeathQueued(queue, playerId) {
        return queue.some(entry => this.createDeathEntry(entry).id === playerId);
    }

    enqueueDeath(queue, playerId, cause) {
        if (!this.players[playerId] || !this.players[playerId].isAlive || this.isDeathQueued(queue, playerId)) return;
        queue.push({ id: playerId, cause });
    }

    applyDeaths(initialDeathIds, defaultCause = 'không rõ nguyên nhân') {
        const deaths = new Set();
        const queue = [];

        for (const rawDeath of Array.from(initialDeathIds || [])) {
            const entry = this.createDeathEntry(rawDeath, defaultCause);
            if (!entry.id || !this.players[entry.id] || !this.players[entry.id].isAlive || this.isDeathQueued(queue, entry.id)) continue;
            queue.push(entry);
        }

        while (queue.length > 0) {
            const { id, cause } = this.createDeathEntry(queue.shift(), defaultCause);
            const player = this.players[id];
            if (!player || !player.isAlive) continue;

            player.isAlive = false;
            player.deathCause = cause || defaultCause;
            deaths.add(id);
            this.handleDeathTriggers(id, queue, deaths);
        }

        return deaths;
    }

    handleDeathTriggers(deadId, queue, deaths) {
        const deadPlayer = this.players[deadId];
        if (!deadPlayer) return;

        if (deadPlayer.role === 'LOUDMOUTH' && deadPlayer.loudmouthTargetId) {
            const target = this.players[deadPlayer.loudmouthTargetId];
            if (target) {
                target.publiclyRevealedRole = true;
                const roleName = RoleRegistry.get(target.role)?.name || target.role;
                this.addActionLog(`${this.getPlayerLabel(deadPlayer)} chết và làm lộ vai trò của ${target.name}: ${roleName}.`);
                this.broadcastSystemMessage(`Bé Mồm Bự ${deadPlayer.name} đã chết. Vai trò của ${target.name} là ${roleName}.`);
            }
        }

        if (deadPlayer.role === 'AVENGER' && deadPlayer.avengerTargetId && this.canAvengerTrigger()) {
            const target = this.players[deadPlayer.avengerTargetId];
            if (target && target.isAlive && !deaths.has(target.id) && !this.isDeathQueued(queue, target.id)) {
                this.enqueueDeath(queue, target.id, 'bị Kẻ Báo Thù kéo chết cùng');
                this.addActionLog(`${this.getPlayerLabel(deadPlayer)} kéo ${this.getPlayerLabel(target)} chết cùng.`);
                this.broadcastSystemMessage(`Kẻ Báo Thù ${deadPlayer.name} kéo ${target.name} chết cùng.`);
            }
        }
    }

    resolveNightActions() {
        // Sort actions by priority to make resolution scalable
        this.nightActions.sort((a, b) => a.priority - b.priority);

        let protections = {}; // targetId -> array of protective sources
        let lethalAttacks = []; // array of { targetId, source }
        let newlyDousedTonight = [];
        const redLadyVisits = {};
        const maidProtections = {};
        const jailProtectedTargets = new Set(Object.values(this.jailerJailedTargetIds || {}));
        
        // Reset doctor tracker
        this.doctorLastHealed = null;
        let turnedPlayerId = null;

        for (const action of this.nightActions) {
            if (action.type === 'DOCTOR_HEAL') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('DOCTOR');
                this.doctorLastHealed = action.targetId;
                this.addActionLog(`Bác sĩ bảo vệ ${this.getPlayerLabel(action.targetId)}.`);
            } else if (action.type === 'RED_LADY_VISIT') {
                redLadyVisits[action.socketId] = action.targetId;
                this.addActionLog(`${this.getPlayerLabel(action.socketId)} ghé thăm ${this.getPlayerLabel(action.targetId)}.`);
            } else if (action.type === 'MAID_PROTECT') {
                maidProtections[action.socketId] = action.targetId;
                this.addActionLog(`${this.getPlayerLabel(action.socketId)} bảo vệ ${this.getPlayerLabel(action.targetId)}.`);
            } else if (action.type === 'WITCH_HEAL') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('WITCH');
                this.witchHealPotion = false;
                this.addActionLog(`Phù Thủy dùng bình cứu ${this.getPlayerLabel(action.targetId)}.`);
            } else if (action.type === 'WEREWOLF_KILL') {
                lethalAttacks.push({ targetId: action.targetId, source: 'WEREWOLF', killerId: this.getWerewolfKillerCandidate(action.targetId) });
            } else if (action.type === 'WITCH_POISON') {
                lethalAttacks.push({ targetId: action.targetId, source: 'WITCH', killerId: action.socketId });
                this.witchPoisonPotion = false;
                this.addActionLog(`Phù Thủy ném bình độc vào ${this.getPlayerLabel(action.targetId)}.`);
            } else if (action.type === 'JAILER_EXECUTE') {
                lethalAttacks.push({ targetId: action.targetId, source: 'JAILER', killerId: action.socketId });
                this.addActionLog(`Giám Ngục xử tử ${this.getPlayerLabel(action.targetId)} trong nhà giam.`);
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
                        lethalAttacks.push({ targetId: id, source: 'ARSONIST', killerId: action.socketId });
                    }
                });
                this.arsonistDoused = [];
                this.arsonistIgniteUsed = true;
                this.addActionLog('Kẻ Phóng Hỏa châm lửa.');
            } else if (action.type === 'CURSED_WOLF_TURN') {
                if (!protections[action.targetId]) protections[action.targetId] = [];
                protections[action.targetId].push('CURSED_WOLF');
                turnedPlayerId = action.targetId;
                this.cursedWolfUsed = true;
                this.addActionLog(`Sói Nguyền nguyền rủa ${this.getPlayerLabel(action.targetId)}.`);
            }
        }

        jailProtectedTargets.forEach(targetId => {
            if (!protections[targetId]) protections[targetId] = [];
            protections[targetId].push('JAIL');
        });

        Object.values(this.players).forEach(p => {
            if (!p.isAlive || p.role !== 'MAID') return;

            if (!protections[p.id]) protections[p.id] = [];
            protections[p.id].push('MAID_SELF');

            const protectedTargetId = maidProtections[p.id];
            if (protectedTargetId && this.players[protectedTargetId] && this.players[protectedTargetId].isAlive) {
                if (!protections[protectedTargetId]) protections[protectedTargetId] = [];
                protections[protectedTargetId].push({ type: 'MAID', protectorId: p.id });
            }
        });

        const pendingDeaths = new Map();
        const markDeath = (playerId, cause) => {
            if (!playerId) return;
            const existingCause = pendingDeaths.get(playerId);
            if (!existingCause) {
                pendingDeaths.set(playerId, cause);
            } else if (existingCause !== cause && !existingCause.includes(cause)) {
                pendingDeaths.set(playerId, `${existingCause}, ${cause}`);
            }
        };
        let deaths = new Set();
        const nightDeathEvidence = new Map();
        const cursedTurnedIds = new Set();
        const attackedTargets = new Set(lethalAttacks
            .filter(attack => !(jailProtectedTargets.has(attack.targetId) && attack.source !== 'JAILER'))
            .map(attack => attack.targetId));
        const doctorSavedTargets = new Set();
        const usedMaidProtections = new Set();
        const usedMaidSelfProtections = new Set();

        // Evaluate attacks against protections
        for (const attack of lethalAttacks) {
            const targetProtections = protections[attack.targetId] || [];
            const attackedPlayer = this.players[attack.targetId];

            if (targetProtections.includes('JAIL') && attack.source !== 'JAILER') {
                continue;
            }

            if (attackedPlayer && attackedPlayer.role === 'RED_LADY' && redLadyVisits[attack.targetId]) {
                continue;
            }
            
            if (attack.source === 'WEREWOLF') {
                if (attackedPlayer && attackedPlayer.role === 'CURSED') {
                    attackedPlayer.role = 'WEREWOLF';
                    attackedPlayer.isWolfAligned = true;
                    cursedTurnedIds.add(attack.targetId);
                    this.addActionLog(`${this.getPlayerLabel(attackedPlayer)} bị sói tấn công và biến thành Ma Sói.`);
                    continue;
                }

                if (this.players[attack.targetId] && this.players[attack.targetId].role === 'ARSONIST') {
                    continue; // Arsonist immune to werewolf kill
                }
                // Werewolf kill blocked by Doctor or Witch heal
                if (targetProtections.includes('DOCTOR') || targetProtections.includes('WITCH') || targetProtections.includes('CURSED_WOLF')) {
                    if (targetProtections.includes('DOCTOR')) {
                        doctorSavedTargets.add(attack.targetId);
                    }
                    continue; // Survived
                }
                if (targetProtections.includes('MAID_SELF') && !usedMaidSelfProtections.has(attack.targetId)) {
                    usedMaidSelfProtections.add(attack.targetId);
                    continue;
                }

                const maidProtection = targetProtections.find(protection => {
                    return protection
                        && protection.type === 'MAID'
                        && !usedMaidProtections.has(protection.protectorId)
                        && this.players[protection.protectorId]
                        && this.players[protection.protectorId].isAlive;
                });

                if (maidProtection) {
                    usedMaidProtections.add(maidProtection.protectorId);
                    markDeath(maidProtection.protectorId, 'bị sói cắn chết khi bảo vệ người khác');
                    continue;
                }
            } else if (attack.source === 'WITCH') {
                // Witch poison ignores Doctor heal (usually), but Witch heal doesn't exist simultaneously with poison for 1 witch
                // However if multiple witches were added later, witch heal might block witch poison.
                if (targetProtections.includes('WITCH')) {
                    continue; // Survived
                }
            }
            // Arsonist ignite goes through everything
            
            const deathCauses = {
                WEREWOLF: 'bị sói cắn chết',
                WITCH: 'bị Phù Thủy ném bình độc',
                ARSONIST: 'bị đốt cháy chết',
                JAILER: 'bị Giám Ngục xử tử'
            };
            if (!nightDeathEvidence.has(attack.targetId)) {
                nightDeathEvidence.set(attack.targetId, { source: attack.source, killerId: attack.killerId, direct: true });
            }
            markDeath(attack.targetId, deathCauses[attack.source] || 'chết trong đêm');
        }

        for (const [redLadyId, targetId] of Object.entries(redLadyVisits)) {
            const redLady = this.players[redLadyId];
            const target = this.players[targetId];
            if (!redLady || !redLady.isAlive || !target) continue;

            if (attackedTargets.has(targetId) || this.isWolfAligned(target) || this.isSoloKiller(target)) {
                markDeath(redLadyId, attackedTargets.has(targetId)
                    ? 'chết vì ghé thăm người bị tấn công'
                    : 'chết vì ghé thăm mục tiêu nguy hiểm');
            }
        }

        deaths = this.applyDeaths(Array.from(pendingDeaths, ([id, cause]) => ({ id, cause })), 'chết trong đêm');
        deaths.forEach(id => this.io.to(id).emit('systemMessage', 'Bạn đã chết trong đêm qua.'));
        cursedTurnedIds.forEach(id => {
            if (!this.players[id] || !this.players[id].isAlive) return;
            this.io.to(id).emit('roleAssigned', 'WEREWOLF');
            this.io.to(id).emit('systemMessage', 'Bạn đã bị Ma Sói tấn công. Bạn không chết, nhưng từ giờ bạn là Ma Sói thường và thắng với phe Sói.');
        });
        this.notifySheriffResults(deaths, nightDeathEvidence);

        this.arsonistDoused = this.arsonistDoused.filter(id => this.players[id] && this.players[id].isAlive);
        this.arsonistNewlyDoused = newlyDousedTonight.filter(id => this.players[id] && this.players[id].isAlive);
        if (this.arsonistNewlyDoused.length > 0) {
            this.addActionLog(`Kẻ Phóng Hỏa tưới xăng ${this.arsonistNewlyDoused.map(id => this.getPlayerLabel(id)).join(', ')}.`);
        }
        this.doctorSavedTargetIds = Array.from(doctorSavedTargets).filter(id => this.players[id] && this.players[id].isAlive);
        const deathMessages = Array.from(deaths).map(id => this.players[id].name);
        if (deathMessages.length > 0) {
            this.addActionLog(`Kết quả đêm: ${Array.from(deaths).map(id => this.getPlayerLabel(id)).join(', ')} chết.`);
            this.broadcastSystemMessage(`Làng thức dậy. ${deathMessages.join(', ')} đã chết đêm qua.`);
        } else {
            this.addActionLog('Kết quả đêm: không ai chết.');
            this.broadcastSystemMessage(`Làng thức dậy. Đêm qua bình yên, không có ai chết.`);
        }

        if (!this.checkWinCondition()) {
            if (turnedPlayerId && this.players[turnedPlayerId] && this.players[turnedPlayerId].isAlive && !deaths.has(turnedPlayerId)) {
                this.players[turnedPlayerId].isWolfAligned = true;
                this.addActionLog(`${this.getPlayerLabel(turnedPlayerId)} bị nguyền và chuyển sang phe Ma Sói.`);
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
        this.jailerJailedTargetIds = {};
        this.sheriffWatchTargetIds = {};
        this.flowerChildProtectedTargetIds = {};
        this.guardianWolfProtectedTargetIds = {};
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
        Object.entries(this.dayVotes).forEach(([voterId, targetId]) => {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + this.getDayVoteWeight(this.players[voterId]);
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

        let flowerProtected = false;
        let guardianProtected = false;
        if (lynchedId) {
            const protectorId = Object.entries(this.flowerChildProtectedTargetIds || {}).find(([flowerChildId, protectedTargetId]) => {
                const flowerChild = this.players[flowerChildId];
                return protectedTargetId === lynchedId && flowerChild && flowerChild.isAlive && flowerChild.role === 'FLOWER_CHILD';
            })?.[0];

            if (protectorId) {
                const protector = this.players[protectorId];
                flowerProtected = true;
                this.addActionLog(`${this.getPlayerLabel(protector)} ngăn cả làng treo cổ ${this.getPlayerLabel(lynchedId)}.`);
                this.broadcastSystemMessage(`Đứa Trẻ Hoa ${protector.name} đã bảo vệ ${this.players[lynchedId].name}. Không ai bị treo cổ hôm nay.`);
                lynchedId = null;
            }
        }

        if (lynchedId) {
            const guardianId = Object.entries(this.guardianWolfProtectedTargetIds || {}).find(([guardianWolfId, protectedTargetId]) => {
                const guardianWolf = this.players[guardianWolfId];
                return protectedTargetId === lynchedId
                    && guardianWolf
                    && guardianWolf.isAlive
                    && guardianWolf.role === 'GUARDIAN_WOLF'
                    && !guardianWolf.guardianWolfUsed;
            })?.[0];

            if (guardianId) {
                const guardian = this.players[guardianId];
                guardian.guardianWolfUsed = true;
                guardian.guardianWolfProtectedTargetId = null;
                guardianProtected = true;
                this.addActionLog(`${this.getPlayerLabel(guardian)} ngăn cả làng treo cổ ${this.getPlayerLabel(lynchedId)}.`);
                this.broadcastSystemMessage(`Sói Hộ Vệ đã bảo vệ ${this.players[lynchedId].name}. Không ai bị treo cổ hôm nay.`);
                lynchedId = null;
            }
        }

        if (lynchedId) {
            const deaths = this.applyDeaths([{ id: lynchedId, cause: 'bị dân làng treo cổ' }]);
            this.addActionLog(`Cả làng vote treo cổ ${this.getPlayerLabel(lynchedId)}.`);
            this.broadcastSystemMessage(`Dân làng đã quyết định treo cổ ${this.players[lynchedId].name}.`);
            this.io.to(lynchedId).emit('systemMessage', 'Bạn đã bị dân làng treo cổ.');
            deaths.forEach(id => {
                if (id !== lynchedId) this.io.to(id).emit('systemMessage', 'Bạn đã chết vì bị Kẻ Báo Thù kéo theo.');
            });
            
            // Kẻ Ngốc win condition
            if (this.players[lynchedId].role === 'FOOL') {
                this.broadcastSystemMessage('Kẻ Ngốc đã bị treo cổ! Kẻ Ngốc đã đánh lừa tất cả mọi người và giành chiến thắng!');
                this.state = 'GAME_OVER';
                this.updateClientState();
                this.revealAllRoles('FOOL');
                return;
            }
        } else {
            this.addActionLog('Cả làng không treo cổ ai.');
            if (!flowerProtected && !guardianProtected) {
                this.broadcastSystemMessage(`Dân làng không thể thống nhất quyết định. Không ai bị treo cổ hôm nay.`);
            }
        }

        this.flowerChildProtectedTargetIds = {};
        this.guardianWolfProtectedTargetIds = {};

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
        
        if (arsonists.length > 0 && wolves.length === 0 && arsonists.length >= villagers.length) {
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
        const allRoles = this.getPlayerIdsInDisplayOrder().map(id => this.players[id]).filter(Boolean).map(p => ({
            name: p.name,
            avatarUrl: p.avatarUrl || null,
            role: p.role
        }));
        this.io.to(this.roomCode).emit('gameOver', {
            winnerTeam: winnerTeam,
            roles: allRoles,
            actionLog: this.getPublicActionLog()
        });

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
        this.playerOrder = [];
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.nightTimer) { clearInterval(this.nightTimer); this.nightTimer = null; }
        this.nightActions = [];
        this.dayVotes = {};
        this.werewolfVotes = {};
        this.witchHealPotion = true;
        this.witchPoisonPotion = true;
        this.doctorLastHealed = null;
        this.doctorProtectedTargetId = null;
        this.doctorSavedTargetIds = [];

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
        this.redLadyVisitTargets = {};
        this.maidProtectedTargetIds = {};
        this.jailerSelectedTargetIds = {};
        this.jailerJailedTargetIds = {};
        this.sheriffWatchTargetIds = {};
        this.flowerChildProtectedTargetIds = {};

        Object.values(this.players).forEach(p => {
            p.role = null;
            p.isWolfAligned = false;
            p.isAlive = true;
            p.seenRoles = {};
            p.seenAuras = {};
            p.auraSeerUsedTonight = false;
            p.wolfSeerUsedTonight = false;
            p.loudmouthTargetId = null;
            p.avengerTargetId = null;
            p.jailerBullet = true;
            p.flowerChildUsed = false;
            p.flowerChildProtectedTargetId = null;
            p.guardianWolfUsed = false;
            p.guardianWolfProtectedTargetId = null;
            p.publiclyRevealedRole = false;
            p.deathCause = null;
        });

        this.io.to(this.roomCode).emit('updatePlayers', this.getPlayers());
        this.updateClientState();
        this.io.to(this.roomCode).emit('gameReset');
    }

    handleChat(socketId, message, channel = 'general-chat') {
        const player = this.players[socketId];
        if (!player) return;

        const chatMsg = {
            senderId: socketId,
            sender: player.name,
            avatarUrl: player.avatarUrl || null,
            message: message,
            isGhost: !player.isAlive,
            isWerewolfChannel: false
        };

        if (!player.isAlive) {
            chatMsg.isGhost = true;
            // Ghost chat - dead players can talk to each other. Medium can hear them at night.
            for (const id in this.players) {
                if (!this.players[id].isAlive) {
                    this.io.to(id).emit('chatMessage', chatMsg);
                }
            }
            if (this.state === 'NIGHT') {
                for (const id in this.players) {
                    const receiver = this.players[id];
                    if (receiver && receiver.isAlive && receiver.role === 'MEDIUM' && !this.isJailedPlayer(id)) {
                        this.io.to(id).emit('chatMessage', chatMsg);
                    }
                }
            }
        } else if (this.state === 'NIGHT') {
            const jail = this.getJailTargetForParticipant(socketId);
            if (jail && (channel === 'jail-chat' || this.isJailedPlayer(socketId))) {
                const senderIsJailer = socketId === jail.jailerId;
                const jailChatMsg = {
                    senderId: null,
                    sender: senderIsJailer ? 'Giám Ngục' : 'Người bị giam',
                    message,
                    isGhost: false,
                    isWerewolfChannel: false,
                    isJailChannel: true
                };
                this.io.to(jail.jailerId).emit('chatMessage', jailChatMsg);
                this.io.to(jail.jailedId).emit('chatMessage', jailChatMsg);
            } else if (channel === 'ghost-chat' && player.role === 'MEDIUM' && !this.isJailedPlayer(socketId)) {
                const mediumChatMsg = {
                    senderId: null,
                    sender: 'Medium',
                    message,
                    isGhost: true,
                    isWerewolfChannel: false,
                    isMediumChannel: true
                };
                for (const id in this.players) {
                    const receiver = this.players[id];
                    if (!receiver) continue;
                    if (!receiver.isAlive || (receiver.role === 'MEDIUM' && receiver.isAlive && !this.isJailedPlayer(id))) {
                        this.io.to(id).emit('chatMessage', mediumChatMsg);
                    }
                }
            } else if (this.isWolfAligned(player)) {
                // If night, werewolves chat in the wolf channel
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
                settings: {
                    revealRoleOnDeath: this.revealRoleOnDeath,
                    showDeathCause: this.showDeathCause,
                    anonymousMatch: this.anonymousMatch
                },
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
                    redLadyVisitTargetId: this.players[socketId].role === 'RED_LADY' ? this.redLadyVisitTargets[socketId] || null : null,
                    maidProtectedTargetId: this.players[socketId].role === 'MAID' ? this.maidProtectedTargetIds[socketId] || null : null,
                    loudmouthTargetId: this.players[socketId].role === 'LOUDMOUTH' ? this.players[socketId].loudmouthTargetId : null,
                    avengerTargetId: this.players[socketId].role === 'AVENGER' ? this.players[socketId].avengerTargetId : null,
                    sheriffWatchTargetIds: this.players[socketId].role === 'SHERIFF' ? this.sheriffWatchTargetIds[socketId] || [] : [],
                    flowerChildUsed: this.players[socketId].role === 'FLOWER_CHILD' ? this.players[socketId].flowerChildUsed === true : false,
                    flowerChildProtectedTargetId: this.players[socketId].role === 'FLOWER_CHILD' ? this.flowerChildProtectedTargetIds[socketId] || null : null,
                    guardianWolfUsed: this.players[socketId].role === 'GUARDIAN_WOLF' ? this.players[socketId].guardianWolfUsed === true : false,
                    guardianWolfProtectedTargetId: this.players[socketId].role === 'GUARDIAN_WOLF' ? this.guardianWolfProtectedTargetIds[socketId] || null : null,
                    jailerSelectedTargetId: this.players[socketId].role === 'JAILER' ? this.jailerSelectedTargetIds[socketId] || null : null,
                    jailerJailedTargetId: this.players[socketId].role === 'JAILER' ? this.jailerJailedTargetIds[socketId] || null : null,
                    jailerBullet: this.players[socketId].role === 'JAILER' ? this.players[socketId].jailerBullet !== false : false,
                    jailedByJailerId: this.getJailerIdForJailedTarget(socketId),
                    isJailedTonight: this.isJailedPlayer(socketId),
                    currentWerewolfVote: this.werewolfVotes ? (this.werewolfVotes[socketId] || null) : null
                }
            };
            this.io.to(socketId).emit('gameStateUpdate', stateForPlayer);
        }
    }
}

module.exports = GameLogic;
