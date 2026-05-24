// ============================================================
// ピタゴラコース - タブレット側 (draw.js)
// ============================================================

(function () {
    'use strict';

    // --- 定数 ---
    var CANVAS_W = 800;
    var CANVAS_H = 600;
    var COLORS = [
        '#2d3436', '#636e72',
        '#d63031', '#e17055',
        '#fdcb6e', '#00b894',
        '#00cec9', '#0984e3',
        '#6c5ce7', '#e84393',
    ];
    var DEFAULT_COLOR = '#2d3436';
    var DEFAULT_SIZE = 8;

    // --- 状態 ---
    var peer = null;
    var conn = null;
    var currentTool = 'pen';
    var currentColor = DEFAULT_COLOR;
    var currentSize = DEFAULT_SIZE;
    var isDrawing = false;
    var currentPoints = [];
    var strokes = [];           // 全ストローク [{points, color, width}, ...]
    var undoStack = [];         // strokes のスナップショット
    var MAX_UNDO = 30;

    // --- DOM ---
    var connectScreen = document.getElementById('connect-screen');
    var drawScreen = document.getElementById('draw-screen');
    var sentScreen = document.getElementById('sent-screen');
    var roomInput = document.getElementById('room-id-input');
    var connectBtn = document.getElementById('connect-btn');
    var connectStatus = document.getElementById('connect-status');
    var canvas = document.getElementById('draw-canvas');
    var ctx = canvas.getContext('2d');
    var sendBtn = document.getElementById('send-btn');
    var undoBtn = document.getElementById('undo-btn');
    var clearBtn = document.getElementById('clear-btn');
    var paletteEl = document.getElementById('color-palette');
    var drawAgainBtn = document.getElementById('draw-again-btn');

    // ============================================================
    // 初期化
    // ============================================================
    function init() {
        setupCanvas();
        buildPalette();
        bindToolbar();
        bindCanvasEvents();
        bindSendButton();
        bindDrawAgain();
        checkURLParams();
        saveUndoState();
    }

    function setupCanvas() {
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        fitCanvasDisplay();
        window.addEventListener('resize', fitCanvasDisplay);
    }

    function fitCanvasDisplay() {
        var wrapper = canvas.parentElement;
        var wrapW = wrapper.clientWidth;
        var wrapH = wrapper.clientHeight;
        var scale = Math.min(wrapW / CANVAS_W, wrapH / CANVAS_H);
        canvas.style.width = Math.floor(CANVAS_W * scale) + 'px';
        canvas.style.height = Math.floor(CANVAS_H * scale) + 'px';
    }

    // ============================================================
    // カラーパレット
    // ============================================================
    function buildPalette() {
        COLORS.forEach(function (color) {
            var btn = document.createElement('button');
            btn.className = 'color-swatch' + (color === currentColor ? ' active' : '');
            btn.dataset.color = color;
            btn.style.background = color;
            btn.setAttribute('aria-label', color);
            btn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                selectColor(color);
            });
            paletteEl.appendChild(btn);
        });
    }

    function selectColor(color) {
        currentColor = color;
        if (currentTool === 'eraser') {
            selectTool('pen');
        }
        paletteEl.querySelectorAll('.color-swatch').forEach(function (el) {
            el.classList.toggle('active', el.dataset.color === color);
        });
    }

    // ============================================================
    // ツールバー
    // ============================================================
    function bindToolbar() {
        document.querySelectorAll('.tool-btn').forEach(function (btn) {
            btn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                selectTool(btn.dataset.tool);
            });
        });
        document.querySelectorAll('.size-btn').forEach(function (btn) {
            btn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                selectSize(parseInt(btn.dataset.size, 10));
            });
        });
        undoBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            undo();
        });
        clearBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            clearCanvas();
        });
    }

    function selectTool(tool) {
        currentTool = tool;
        document.querySelectorAll('.tool-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
    }

    function selectSize(size) {
        currentSize = size;
        document.querySelectorAll('.size-btn').forEach(function (btn) {
            btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === size);
        });
    }

    // ============================================================
    // Undo / Clear
    // ============================================================
    function saveUndoState() {
        undoStack.push(JSON.parse(JSON.stringify(strokes)));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function undo() {
        if (undoStack.length <= 1) return;
        undoStack.pop();
        strokes = JSON.parse(JSON.stringify(undoStack[undoStack.length - 1]));
        redrawCanvas();
        sendBtn.disabled = strokes.length === 0;
    }

    function clearCanvas() {
        strokes = [];
        redrawCanvas();
        saveUndoState();
        sendBtn.disabled = true;
    }

    // ============================================================
    // キャンバス描画
    // ============================================================
    function bindCanvasEvents() {
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointerleave', onPointerUp);
        canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    }

    function getCanvasPos(e) {
        var rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
            y: (e.clientY - rect.top) * (CANVAS_H / rect.height),
        };
    }

    function onPointerDown(e) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        isDrawing = true;
        currentPoints = [getCanvasPos(e)];

        if (currentTool === 'eraser') {
            eraseAtPoint(currentPoints[0]);
        }
    }

    function onPointerMove(e) {
        if (!isDrawing) return;
        e.preventDefault();
        var pos = getCanvasPos(e);

        if (currentTool === 'eraser') {
            eraseAtPoint(pos);
            return;
        }

        currentPoints.push(pos);
        redrawCanvas();
        drawCurrentStroke();
    }

    function onPointerUp(e) {
        if (!isDrawing) return;
        isDrawing = false;

        if (currentTool === 'pen' && currentPoints.length >= 2) {
            // ストロークを確定（スムージング処理）
            var smoothed = smoothPoints(currentPoints);
            strokes.push({
                points: smoothed,
                color: currentColor,
                width: currentSize,
            });
            saveUndoState();
            sendBtn.disabled = false;
        }

        currentPoints = [];
        redrawCanvas();
    }

    // 消しゴム：近くのストロークを削除
    function eraseAtPoint(pos) {
        var eraserRadius = 20;
        var changed = false;
        for (var i = strokes.length - 1; i >= 0; i--) {
            var stroke = strokes[i];
            for (var j = 0; j < stroke.points.length; j++) {
                var p = stroke.points[j];
                var dx = p.x - pos.x;
                var dy = p.y - pos.y;
                if (dx * dx + dy * dy < eraserRadius * eraserRadius) {
                    strokes.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        if (changed) {
            redrawCanvas();
            saveUndoState();
            sendBtn.disabled = strokes.length === 0;
        }
    }

    // ポイントのスムージング（間引き + ベジェ補間のための中間点追加）
    function smoothPoints(pts) {
        if (pts.length <= 2) return pts.slice();

        // 距離ベースで間引き
        var minDist = 5;
        var filtered = [pts[0]];
        for (var i = 1; i < pts.length; i++) {
            var dx = pts[i].x - filtered[filtered.length - 1].x;
            var dy = pts[i].y - filtered[filtered.length - 1].y;
            if (dx * dx + dy * dy >= minDist * minDist) {
                filtered.push(pts[i]);
            }
        }
        // 最後の点は必ず含める
        var last = pts[pts.length - 1];
        if (filtered[filtered.length - 1] !== last) {
            filtered.push(last);
        }
        return filtered;
    }

    // 全ストロークを再描画
    function redrawCanvas() {
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        strokes.forEach(function (stroke) {
            drawStroke(stroke.points, stroke.color, stroke.width);
        });
    }

    // 確定済みストロークの描画中ストロークを表示
    function drawCurrentStroke() {
        if (currentPoints.length < 2) return;
        drawStroke(currentPoints, currentColor, currentSize);
    }

    // ストローク描画（ベジェ曲線）
    function drawStroke(points, color, width) {
        if (points.length < 2) return;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);

        if (points.length === 2) {
            ctx.lineTo(points[1].x, points[1].y);
        } else {
            for (var i = 1; i < points.length - 1; i++) {
                var midX = (points[i].x + points[i + 1].x) / 2;
                var midY = (points[i].y + points[i + 1].y) / 2;
                ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
            }
            var last = points[points.length - 1];
            ctx.lineTo(last.x, last.y);
        }

        ctx.stroke();
        ctx.restore();
    }

    // ============================================================
    // 送信
    // ============================================================
    function bindSendButton() {
        sendBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            if (sendBtn.disabled) return;
            sendRails();
        });
    }

    function sendRails() {
        if (strokes.length === 0) return;

        // 座標を 0-1 に正規化して送信
        var normalizedStrokes = strokes.map(function (stroke) {
            return {
                points: stroke.points.map(function (p) {
                    return {
                        x: p.x / CANVAS_W,
                        y: p.y / CANVAS_H,
                    };
                }),
                color: stroke.color,
                width: stroke.width / CANVAS_W, // 太さも正規化
            };
        });

        if (conn && conn.open) {
            conn.send({
                type: 'rail',
                strokes: normalizedStrokes,
            });
        }

        // 送信完了画面へ
        drawScreen.style.display = 'none';
        sentScreen.style.display = 'block';
    }

    // ============================================================
    // 送信後 → 再描画
    // ============================================================
    function bindDrawAgain() {
        drawAgainBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            returnToCanvas();
        });
    }

    function returnToCanvas() {
        sentScreen.style.display = 'none';
        drawScreen.style.display = 'flex';
        strokes = [];
        undoStack = [];
        redrawCanvas();
        saveUndoState();
        sendBtn.disabled = true;
        fitCanvasDisplay();
    }

    // ============================================================
    // PeerJS 接続
    // ============================================================
    function checkURLParams() {
        var params = new URLSearchParams(window.location.search);
        var roomId = params.get('room');
        if (roomId) {
            roomInput.value = roomId;
            connectToPeer(roomId);
        }
    }

    connectBtn.addEventListener('click', function () {
        var roomId = roomInput.value.trim();
        if (!roomId) {
            connectStatus.textContent = 'ルームIDをいれてね';
            return;
        }
        connectToPeer(roomId);
    });

    roomInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') connectBtn.click();
    });

    function connectToPeer(roomId) {
        connectStatus.textContent = 'せつぞくちゅう...';
        connectBtn.disabled = true;

        peer = new Peer();

        peer.on('open', function () {
            conn = peer.connect('pythagoras-' + roomId, { reliable: true });

            conn.on('open', function () {
                connectStatus.textContent = '';
                connectScreen.style.display = 'none';
                drawScreen.style.display = 'flex';
                fitCanvasDisplay();
            });

            conn.on('close', function () {
                showDisconnected();
            });

            conn.on('error', function () {
                connectStatus.textContent = 'せつぞくできませんでした';
                connectBtn.disabled = false;
            });
        });

        peer.on('error', function (err) {
            connectStatus.textContent = 'エラー: ' + err.type;
            connectBtn.disabled = false;
        });

        setTimeout(function () {
            if (!conn || !conn.open) {
                connectStatus.textContent = 'せつぞくできませんでした。ルームIDをかくにんしてね。';
                connectBtn.disabled = false;
                if (peer) peer.destroy();
            }
        }, 10000);
    }

    function showDisconnected() {
        sentScreen.style.display = 'none';
        drawScreen.style.display = 'none';
        connectScreen.style.display = 'flex';
        connectStatus.textContent = 'せつぞくがきれました。もういちどつなげてね。';
        connectBtn.disabled = false;
    }

    // ============================================================
    // 起動
    // ============================================================
    init();
})();
