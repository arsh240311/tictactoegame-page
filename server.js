// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid'); // For unique tokens (npm install uuid)

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
const CORS_ORIGIN = [
    "https://helpful-rabanadas-81685b.netlify.app",
    "https://vertexseolabs.netlify.app",
    "http://localhost:3000",
    "http://localhost:3001"
];

// --- App & Server Setup ---
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ["GET", "POST"]
    }
});

// --- In-Memory Storage ---
const rooms = new Map();
const waitingPlayers = []; // Queue for public matchmaking

// --- Game Logic ---
const WINNING_COMBINATIONS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6]             // diagonals
];

function initializeGameState() {
    return {
        board: Array(9).fill(''),
        currentPlayer: 'X',
        gameActive: true,
        scores: { winsX: 0, winsO: 0, draws: 0 },
        messages: [],
        winningCells: null
    };
}

function checkWin(board) {
    for (const combination of WINNING_COMBINATIONS) {
        const [a, b, c] = combination;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { win: true, winner: board[a], winningCells: combination };
        }
    }
    return { win: false };
}

function checkDraw(board) {
    return board.every(cell => cell !== '');
}

function resetGameForNewRound(room) {
    room.board.fill('');
    room.gameActive = true;
    room.winningCells = null;
    room.currentPlayer = room.lastStartingPlayer === 'X' ? 'O' : 'X';
    room.lastStartingPlayer = room.currentPlayer;
}

// --- Helper Functions ---
const sanitize = (str) => String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;");

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function broadcastRoomState(roomId) {
    if (!rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const roomState = {
        roomId,
        players: Array.from(room.players.values()),
        board: room.board,
        currentPlayer: room.currentPlayer,
        gameActive: room.gameActive,
        scores: room.scores,
        messages: room.messages,
        winningCells: room.winningCells,
    };
    io.to(roomId).emit('roomState', roomState);
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    // Room-Based Multiplayer
    socket.on('createRoom', (playerName) => {
        const roomId = generateRoomId();
        const sanitizedName = sanitize(playerName);
        const playerToken = uuidv4();
        const room = {
            ...initializeGameState(),
            players: new Map(),
            lastStartingPlayer: 'X',
        };
        room.players.set(socket.id, { id: socket.id, name: sanitizedName, role: 'X', token: playerToken });
        rooms.set(roomId, room);
        socket.join(roomId);
        console.log(`Player ${sanitizedName} (${socket.id}) created room ${roomId}`);
        socket.emit('roomCreated', { roomId, playerToken, role: 'X' });
        broadcastRoomState(roomId);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const sanitizedName = sanitize(playerName);
        if (!rooms.has(roomId)) return socket.emit('roomError', 'Room not found.');
        const room = rooms.get(roomId);
        if (room.players.size >= 2) return socket.emit('roomError', 'Room is full.');

        const playerToken = uuidv4();
        room.players.set(socket.id, { id: socket.id, name: sanitizedName, role: 'O', token: playerToken });
        socket.join(roomId);
        console.log(`Player ${sanitizedName} (${socket.id}) joined room ${roomId}`);
        socket.emit('roomJoined', { roomId, playerToken, role: 'O' });
        broadcastRoomState(roomId);
    });

    // Public Matchmaking
    socket.on('findOpponent', (playerName) => {
        const sanitizedName = sanitize(playerName);
        if (waitingPlayers.length > 0) {
            const opponent = waitingPlayers.shift();
            const roomId = generateRoomId();
            const room = { ...initializeGameState(), players: new Map(), lastStartingPlayer: 'X' };
            rooms.set(roomId, room);
            const player1Token = uuidv4();
            const player2Token = uuidv4();
            room.players.set(opponent.socket.id, { id: opponent.socket.id, name: opponent.name, role: 'X', token: player1Token });
            room.players.set(socket.id, { id: socket.id, name: sanitizedName, role: 'O', token: player2Token });
            opponent.socket.join(roomId);
            socket.join(roomId);
            console.log(`Matched ${opponent.name} and ${sanitizedName} in room ${roomId}`);
            opponent.socket.emit('opponentFound', { roomId, playerToken: player1Token, role: 'X' });
            socket.emit('opponentFound', { roomId, playerToken: player2Token, role: 'O' });
            broadcastRoomState(roomId);
        } else {
            waitingPlayers.push({ socket, name: sanitizedName });
            socket.emit('waitingForOpponent');
        }
    });

    socket.on('cancelFindOpponent', () => {
        const index = waitingPlayers.findIndex(p => p.socket.id === socket.id);
        if (index !== -1) {
            waitingPlayers.splice(index, 1);
            console.log(`Player ${socket.id} cancelled search.`);
        }
    });

    // Game Actions
    socket.on('makeMove', ({ roomId, cellIndex }) => {
        if (!rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        // This is the key fix: only get player data from the room itself.
        const player = room.players.get(socket.id); 
        
        // This validation is now cleaner and more reliable.
        if (!player || player.role !== room.currentPlayer || room.board[cellIndex] !== '' || !room.gameActive) {
            return; // Exit silently if the move is invalid.
        }

        room.board[cellIndex] = room.currentPlayer;
        const winResult = checkWin(room.board);
        if (winResult.win) {
            room.gameActive = false;
            room.winningCells = winResult.winningCells;
            if (winResult.winner === 'X') room.scores.winsX++; else room.scores.winsO++;
        } else if (checkDraw(room.board)) {
            room.gameActive = false;
            room.scores.draws++;
        } else {
            room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
        }
        broadcastRoomState(roomId);
    });

    socket.on('resetGame', (roomId) => {
        if (!rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        if (!room.players.has(socket.id)) return;
        resetGameForNewRound(room);
        broadcastRoomState(roomId);
    });

    socket.on('sendMessage', ({ roomId, message }) => {
        if (!rooms.has(roomId)) return;
        const room = rooms.get(roomId);
        const player = room.players.get(socket.id);
        if (!player) return;

        const sanitizedMessage = sanitize(message);
        room.messages.push({ playerId: socket.id, playerName: player.name, message: sanitizedMessage });
        io.to(roomId).emit('messageReceived', room.messages);
    });

    // Disconnection and Reconnection
    socket.on('reconnectGame', ({ playerToken }) => {
        for (const [roomId, room] of rooms.entries()) {
            for (const [id, player] of room.players.entries()) {
                if (player.token === playerToken) {
                    const oldSocketId = id;
                    const playerData = room.players.get(oldSocketId);
                    if (room.disconnectTimers && room.disconnectTimers.has(oldSocketId)) {
                        clearTimeout(room.disconnectTimers.get(oldSocketId));
                        room.disconnectTimers.delete(oldSocketId);
                    }
                    playerData.id = socket.id;
                    room.players.delete(oldSocketId);
                    room.players.set(socket.id, playerData);
                    socket.join(roomId);
                    console.log(`Player ${playerData.name} (${socket.id}) reconnected to room ${roomId}`);
                    socket.emit('reconnectSuccess', { roomId });
                    broadcastRoomState(roomId);
                    return;
                }
            }
        }
        socket.emit('reconnectFailed');
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const waitingIndex = waitingPlayers.findIndex(p => p.socket.id === socket.id);
        if (waitingIndex !== -1) waitingPlayers.splice(waitingIndex, 1);

        for (const [roomId, room] of rooms.entries()) {
            if (room.players.has(socket.id)) {
                const disconnectedPlayer = room.players.get(socket.id);
                console.log(`Player ${disconnectedPlayer.name} disconnected from room ${roomId}`);
                socket.to(roomId).emit('playerDisconnected', { playerName: disconnectedPlayer.name });

                const timer = setTimeout(() => {
                    const playerStillExists = Array.from(room.players.values()).some(p => p.token === disconnectedPlayer.token);
                    if (playerStillExists) room.players.delete(socket.id);
                    console.log(`Player ${disconnectedPlayer.name} timed out from room ${roomId}`);
                    if (room.players.size === 0) {
                        rooms.delete(roomId);
                        console.log(`Room ${roomId} deleted due to abandonment.`);
                    } else {
                        broadcastRoomState(roomId);
                    }
                }, 30000);

                if (!room.disconnectTimers) room.disconnectTimers = new Map();
                room.disconnectTimers.set(socket.id, timer);
                break;
            }
        }
    });
});

// --- Start Server ---
server.listen(PORT, HOST, () => {
    console.log(`✅ Tic Tac Toe server is running on http://${HOST}:${PORT}`);
});
