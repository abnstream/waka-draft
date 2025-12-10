const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- 設定 ---
const MIN_PLAYERS = 2; 
const MAX_PLAYERS = 7; 
const PORT = process.env.PORT || 3000;

// --- ゲームの状態変数 ---
let players = {};
let playerOrder = [];
let revealOrder = [];
let currentRevealIndex = 0;
let isGameStarted = false;

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
    Object.keys(players).forEach(id => {
        players[id].pack = [];
        players[id].hand = [];
        players[id].selected = null;
        players[id].finalWaka = null;
    });
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
        console.log(`      現在の人数: ${Object.keys(players).length}人`);

        io.emit('update_player_list', Object.values(players).map(p => p.name));
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
        console.log("   参加者順: " + playerOrder.map(id => players[id].name).join(" → "));
        console.log("=========================================");

        io.emit('move_to_input');
    });

    // 3. パック提出
    socket.on('submit_pack', (packData) => {
        if (!players[socket.id]) return;
        players[socket.id].pack = packData;

        // ログ出力：提出された言葉を見やすく表示
        const words = packData.map(item => item.text).join(", ");
        console.log(`[提出] ${players[socket.id].name} がパックを作成: [${words}]`);

        checkAllSubmitted();
    });

    // 4. ドラフト選択
    socket.on('pick_card', (index) => {
        const player = players[socket.id];
        if (!player || !player.pack[index] || player.selected !== null) return;
        
        // 選んだカードの内容を取得
        const pickedCard = player.pack[index];
        player.selected = pickedCard;
        player.pack.splice(index, 1);

        console.log(`[選択] ${player.name} が「${pickedCard.text}」を選択`);

        checkAllPicked();
    });

    // 5. 発表準備完了（和歌保存）
    socket.on('ready_to_present', (wakaData) => {
        const player = players[socket.id];
        if(player) {
            player.finalWaka = wakaData;
            
            // 和歌を繋げてログ表示
            const fullWaka = wakaData.map(w => w.text).join(" ");
            console.log(`[完成] ${player.name} の和歌: 『${fullWaka}』`);
            
            io.emit('announce_start', { name: player.name });
        }
    });

    // 6. 1フレーズ表示
    socket.on('reveal_step', (cardObj) => {
        // 詳細すぎるのでここはログ省略しても良いが、デバッグ用に残すなら以下
        // console.log(`[発表] ... ${cardObj.text}`);
        io.emit('show_step', cardObj);
    });

    // 7. 発表終了・次へ
    socket.on('finish_turn', () => {
        currentRevealIndex++;
        
        if (currentRevealIndex >= revealOrder.length) {
            console.log("🏁 全員の発表が終了しました。結果画面へ移行します。");
            
            const results = revealOrder.map(id => {
                const p = players[id];
                return { name: p.name, waka: p.finalWaka };
            }).filter(item => item.waka);

            io.emit('game_over', results);
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
    playerOrder.forEach(id => {
        io.to(id).emit('next_draft_turn', {
            pack: players[id].pack,
            hand: players[id].hand
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
        console.log(`👉 次の発表者: ${nextPlayerName} さん`);
        
        io.emit('update_reveal_status', { currentName: nextPlayerName, isMe: false });
        io.to(nextPlayerId).emit('your_reveal_turn', { hand: players[nextPlayerId].hand });
    } else {
        // プレイヤー不在時のスキップ処理
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