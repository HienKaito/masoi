const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameLogic = require('./game/GameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Cho phép tất cả các nguồn (có thể thay bằng domain cụ thể của bạn để bảo mật hơn)
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active games
const games = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('createRoom', ({ playerName }) => {
        // Generate a random 4-letter room code
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        games[roomCode] = new GameLogic(roomCode, io);

        socket.join(roomCode);
        const player = games[roomCode].addPlayer(socket.id, playerName, true);

        socket.emit('roomCreated', { roomCode, player });
        io.to(roomCode).emit('updatePlayers', games[roomCode].getPlayers());
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const code = roomCode.toUpperCase();
        if (games[code]) {
            if (games[code].state !== 'LOBBY') {
                socket.emit('error', 'Game has already started.');
                return;
            }
            socket.join(code);
            const player = games[code].addPlayer(socket.id, playerName, false);
            socket.emit('roomJoined', { roomCode: code, player });
            if (games[code].settings) {
                socket.emit('settingsUpdated', games[code].settings);
            }
            io.to(code).emit('updatePlayers', games[code].getPlayers());
        } else {
            socket.emit('error', 'Room not found.');
        }
    });

    socket.on('startGame', ({ roomCode, settings }) => {
        const game = games[roomCode];
        if (game && game.players[socket.id] && game.players[socket.id].isHost) {
            game.startGame(socket.id, settings);
        }
    });

    socket.on('playAgain', (roomCode) => {
        const game = games[roomCode];
        if (game && game.players[socket.id] && game.players[socket.id].isHost) {
            game.resetGame();
        }
    });

    socket.on('updateSettings', ({ roomCode, settings }) => {
        const game = games[roomCode];
        if (game) {
            game.settings = settings;
            socket.to(roomCode).emit('settingsUpdated', settings);
        }
    });

    // Chat handling
    socket.on('sendMessage', ({ roomCode, message }) => {
        const game = games[roomCode];
        if (game) {
            game.handleChat(socket.id, message);
        }
    });

    // WebRTC Signaling
    socket.on('webrtc-join', (roomCode) => {
        socket.to(roomCode).emit('webrtc-peer-joined', socket.id);
    });

    socket.on('webrtc-signal', ({ targetId, type, payload }) => {
        io.to(targetId).emit('webrtc-signal', {
            senderId: socket.id,
            type,
            payload
        });
    });

    // Game Actions
    socket.on('playerAction', ({ roomCode, actionType, targetId }) => {
        const game = games[roomCode];
        if (game) {
            game.handleAction(socket.id, actionType, targetId);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Handle player disconnect logic (remove from room, handle host migration, etc.)
        for (const roomCode in games) {
            if (games[roomCode].players[socket.id]) {
                games[roomCode].removePlayer(socket.id);
                io.to(roomCode).emit('updatePlayers', games[roomCode].getPlayers());

                // If room empty, delete game
                if (Object.keys(games[roomCode].players).length === 0) {
                    delete games[roomCode];
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
