const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 設定 ---
const MIN_PLAYERS = 2; 
const MAX_PLAYERS = 7; 
const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 50; 

// --- ゲームの状態変数 ---
let players = {};
let playerOrder = [];
let revealOrder = [];
let currentRevealIndex = 0;
let isGameStarted = false;

// ★直近の和歌を保存するリスト
let wakaHistory = [];

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function resetGame() {
    isGameStarted = false;
    playerOrder = [];
    revealOrder = [];
    currentRevealIndex = 0;
    // プレイヤー情報はdisconnectで消えるため、ここでplayersのリセットは最小限でOK
    console.log("=========================================");
    console.log("   🔄 ゲーム状態をリセットしました");
    console.log("=========================================");
}

io.on('connection', (socket) => {
    // 1. 参加
    socket.on('join_game', (name) => {
        if (isGameStarted) {
            socket.emit('error_msg', "現在ゲーム進行中です。");
            return;
        }
        if (Object.keys(players).length >= MAX_PLAYERS) {
            socket.emit('error_msg', `満員です。`);
            return;
        }
        
        players[socket.id] = { id: socket.id, name: name, pack: [], hand: [], selected: null, finalWaka: null };
        
        console.log(`[参加] ${name} さんが入室しました (ID: ${socket.id})`);
        io.emit('update_player_list', Object.values(players).map(p => p.name));
    });

    // 履歴データの要求に応答
    socket.on('request_history', () => {
        socket.emit('receive_history', wakaHistory);
    });

    // 2. ゲーム開始
    socket.on('start_game_signal', () => {
        const ids = Object.keys(players);
        if (ids.length < MIN_PLAYERS) {
            io.emit('error_msg', `最低${MIN_PLAYERS}人が必要です。`);
            return; 
        }
        isGameStarted = true;
        playerOrder = shuffle(ids);
        
        console.log("=========================================");
        console.log("   🎮 ゲーム開始！");
        io.emit('move_to_input');
    });

    // 3. パック提出
    socket.on('submit_pack', (packData) => {
        if (!players[socket.id]) return;
        players[socket.id].pack = packData;

        // ★追加機能：提出状況を集計して全員に通知
        const submittedCount = Object.values(players).filter(p => p.pack.length > 0).length;
        const totalPlayers = Object.keys(players).length;
        io.emit('update_submit_status', { current: submittedCount, total: totalPlayers });

        checkAllSubmitted();
    });

    // 4. ドラフト選択
    socket.on('pick_card', (index) => {
        const player = players[socket.id];
        if (!player || !player.pack[index] || player.selected !== null) return;
        
        player.selected = player.pack[index];
        player.pack.splice(index, 1);
        checkAllPicked();
    });

    // 5. 発表準備完了
    socket.on('ready_to_present', (wakaData) => {
        const player = players[socket.id];
        if(player) {
            player.finalWaka = wakaData;
            io.emit('announce_start', { name: player.name });
        }
    });

    // 6. 1フレーズ表示
    socket.on('reveal_step', (cardObj) => {
        io.emit('show_step', cardObj);
    });

    // 7. 発表終了・次へ
    socket.on('finish_turn', () => {
        currentRevealIndex++;
        
        if (currentRevealIndex >= revealOrder.length) {
            console.log("🏁 全員の発表が終了しました。結果画面へ移行します。");
            
            // 結果リスト作成
            const results = revealOrder.map(id => {
                const p = players[id];
                return { name: p.name, waka: p.finalWaka };
            }).filter(item => item.waka);

            // 履歴に追加
            results.forEach(res => {
                wakaHistory.unshift(res);
            });
            if (wakaHistory.length > MAX_HISTORY) {
                wakaHistory = wakaHistory.slice(0, MAX_HISTORY);
            }

            io.emit('game_over', results);

            // ★追加機能：全員の接続を強制切断（名前残りを防ぐため）
            io.fetchSockets().then((sockets) => {
                sockets.forEach((s) => s.disconnect(true));
            }).catch(err => {
                console.log("Socket切断エラー(またはバージョン差異):", err);
                Object.values(io.sockets.sockets).forEach(s => s.disconnect(true));
            });

            resetGame();
        } else {
            nextRevealTurn();
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log(`[退室] ${players[socket.id].name} さんが切断しました`);
            delete players[socket.id];
            if (!isGameStarted) {
                io.emit('update_player_list', Object.values(players).map(p => p.name));
            }
        }
        if (Object.keys(players).length === 0) {
            resetGame();
        }
    });
});

// --- ロジック関数 ---

function checkAllSubmitted() {
    const allReady = playerOrder.every(id => players[id] && players[id].pack.length > 0);
    if (allReady && playerOrder.length > 0) {
        console.log("✨ 全員パック提出完了。ドラフトを開始します。");
        rotatePacks();
        startDraftTurn();
    }
}

function checkAllPicked() {
    const allPicked = playerOrder.every(id => players[id] && players[id].selected !== null);
    if (allPicked) {
        playerOrder.forEach(id => {
            players[id].hand.push(players[id].selected);
            players[id].selected = null;
        });

        if (players[playerOrder[0]].pack.length === 0) {
            startRevealPhase();
        } else {
            console.log("🔄 ターン終了。パックを回します。");
            rotatePacks();
            startDraftTurn();
        }
    }
}

function rotatePacks() {
    if(playerOrder.length < 2) return;
    const lastPack = players[playerOrder[playerOrder.length - 1]].pack;
    for (let i = playerOrder.length - 1; i > 0; i--) {
        players[playerOrder[i]].pack = players[playerOrder[i - 1]].pack;
    }
    players[playerOrder[0]].pack = lastPack;
}

function startDraftTurn() {
    playerOrder.forEach((id, index) => {
        // ★追加機能：誰から回ってきたか特定
        const prevIndex = (index - 1 + playerOrder.length) % playerOrder.length;
        const prevPlayerId = playerOrder[prevIndex];
        const fromName = players[prevPlayerId] ? players[prevPlayerId].name : "誰か";

        io.to(id).emit('next_draft_turn', {
            pack: players[id].pack,
            hand: players[id].hand,
            fromName: fromName // 送り主の名前を追加
        });
    });
}

function startRevealPhase() {
    console.log("🎤 ドラフト終了。発表フェーズへ移行します。");
    revealOrder = shuffle([...playerOrder]);
    currentRevealIndex = 0;
    io.emit('start_reveal_phase');
    nextRevealTurn();
}

function nextRevealTurn() {
    const nextPlayerId = revealOrder[currentRevealIndex];
    if (players[nextPlayerId]) {
        const nextPlayerName = players[nextPlayerId].name;
        io.emit('update_reveal_status', { currentName: nextPlayerName, isMe: false });
        io.to(nextPlayerId).emit('your_reveal_turn', { hand: players[nextPlayerId].hand });
    } else {
        // プレイヤーが不在の場合はスキップ
        currentRevealIndex++;
        if (currentRevealIndex >= revealOrder.length) {
            io.emit('game_over', []); 
            resetGame();
        } else {
            nextRevealTurn();
        }
    }
}

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});