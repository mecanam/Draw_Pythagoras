// ============================================================
// ピタゴラコース - PC側 (course.js)
// Matter.js 物理演算 + PeerJS サーバー
// ============================================================

(function () {
    'use strict';

    // --- Matter.js エイリアス ---
    var Engine = Matter.Engine;
    var Render = Matter.Render;
    var Runner = Matter.Runner;
    var Bodies = Matter.Bodies;
    var Body = Matter.Body;
    var Composite = Matter.Composite;
    var Events = Matter.Events;

    // --- 設定 ---
    var ballMode = 'manual';     // 'manual' | 'auto'
    var autoInterval = 5;        // 秒
    var autoTimerId = null;
    var autoCountdown = 0;
    var countdownTimerId = null;

    // --- 状態 ---
    var peer = null;
    var connections = [];
    var roomId = '';
    var isRunning = false;

    // Matter.js
    var engine = null;
    var canvas = null;
    var ctx = null;
    var animationId = null;

    // レールとボールの管理
    var railBodies = [];         // {bodies: [...], stroke: {...}} の配列
    var balls = [];              // Matter.js Body の配列
    var ballDropX = 0.5;         // 正規化された投入X位置 (0-1)
    var BALL_RADIUS = 12;
    var RAIL_THICKNESS = 8;

    // --- DOM ---
    var lobby = document.getElementById('lobby');
    var course = document.getElementById('course');
    var roomIdEl = document.getElementById('room-id');
    var qrCanvas = document.getElementById('qr-canvas');
    var startBtn = document.getElementById('start-btn');
    var lobbyStatus = document.getElementById('lobby-status');
    var courseCanvas = document.getElementById('course-canvas');
    var ballMarker = document.getElementById('ball-marker');
    var dropBallBtn = document.getElementById('drop-ball-btn');
    var clearRailsBtn = document.getElementById('clear-rails-btn');
    var exitBtn = document.getElementById('exit-btn');
    var autoIndicator = document.getElementById('auto-indicator');
    var autoCountdownEl = document.getElementById('auto-countdown');
    var autoSettings = document.getElementById('auto-settings');
    var intervalInput = document.getElementById('ball-interval');
    var intervalValue = document.getElementById('interval-value');
    var modeManualBtn = document.getElementById('mode-manual-btn');
    var modeAutoBtn = document.getElementById('mode-auto-btn');
    var goalZone = document.getElementById('goal-zone');

    // ============================================================
    // ルームID生成
    // ============================================================
    function generateRoomId() {
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        var id = '';
        for (var i = 0; i < 6; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }

    // ============================================================
    // PeerJS セットアップ
    // ============================================================
    function setupPeer() {
        roomId = generateRoomId();
        roomIdEl.textContent = roomId;

        var drawUrl = getDrawUrl();
        try {
            QRCode.toCanvas(qrCanvas, drawUrl, {
                width: 140,
                margin: 1,
                color: { dark: '#1a1a2e', light: '#ffffff' }
            }, function (err) {
                if (err) console.error('QR生成エラー:', err);
            });
        } catch (e) {
            console.error('QRライブラリエラー:', e);
        }

        lobbyStatus.textContent = 'せつぞくじゅんびちゅう...';

        peer = new Peer('pythagoras-' + roomId);

        peer.on('open', function () {
            lobbyStatus.textContent = 'タブレットからのせつぞくをまっています...';
        });

        peer.on('connection', function (conn) {
            connections.push(conn);
            lobbyStatus.textContent = connections.length + ' 台のタブレットがせつぞくちゅう';

            conn.on('data', function (data) {
                if (data && data.type === 'rail') {
                    addRails(data.strokes);
                }
            });

            conn.on('close', function () {
                connections = connections.filter(function (c) { return c !== conn; });
                if (connections.length > 0) {
                    lobbyStatus.textContent = connections.length + ' 台のタブレットがせつぞくちゅう';
                } else {
                    lobbyStatus.textContent = 'タブレットからのせつぞくをまっています...';
                }
            });
        });

        peer.on('error', function (err) {
            lobbyStatus.textContent = 'エラー: ' + err.type;
        });
    }

    function getDrawUrl() {
        var loc = window.location;
        var base = loc.protocol + '//' + loc.host + loc.pathname;
        base = base.replace(/index\.html$/, '').replace(/\/$/, '');
        return base + '/draw.html?room=' + roomId;
    }

    // ============================================================
    // ロビーUI
    // ============================================================
    modeManualBtn.addEventListener('click', function () {
        ballMode = 'manual';
        modeManualBtn.classList.add('active');
        modeAutoBtn.classList.remove('active');
        autoSettings.style.display = 'none';
    });

    modeAutoBtn.addEventListener('click', function () {
        ballMode = 'auto';
        modeAutoBtn.classList.add('active');
        modeManualBtn.classList.remove('active');
        autoSettings.style.display = 'block';
    });

    intervalInput.addEventListener('input', function () {
        autoInterval = parseInt(intervalInput.value);
        intervalValue.textContent = autoInterval;
    });

    startBtn.addEventListener('click', function () {
        startCourse();
    });

    // ============================================================
    // コース起動
    // ============================================================
    function startCourse() {
        isRunning = true;
        lobby.style.display = 'none';
        course.style.display = 'block';

        initPhysics();
        resizeCanvas();
        window.addEventListener('resize', onResize);

        // フルスクリーン
        var el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();

        // 球投入マーカーのドラッグ
        setupMarkerDrag();

        // コントロールバー
        setupControls();

        // 自動モード
        if (ballMode === 'auto') {
            startAutoMode();
        }

        // アニメーション開始
        animate();
    }

    function onResize() {
        resizeCanvas();
        // 物理エンジンの壁を再構築
        rebuildWalls();
    }

    function resizeCanvas() {
        courseCanvas.width = window.innerWidth;
        courseCanvas.height = window.innerHeight;
        canvas = courseCanvas;
        ctx = canvas.getContext('2d');
    }

    // ============================================================
    // Matter.js 物理エンジン初期化
    // ============================================================
    var wallBodies = [];

    function initPhysics() {
        engine = Engine.create({
            gravity: { x: 0, y: 1.2 },
        });

        canvas = courseCanvas;
        ctx = canvas.getContext('2d');

        rebuildWalls();
    }

    function rebuildWalls() {
        // 既存の壁を削除
        if (wallBodies.length > 0) {
            Composite.remove(engine.world, wallBodies);
        }

        var W = window.innerWidth;
        var H = window.innerHeight;
        var wallThickness = 60;

        // 左壁と右壁のみ（底面はゴール判定用なので壁なし）
        wallBodies = [
            Bodies.rectangle(-wallThickness / 2, H / 2, wallThickness, H * 2, { isStatic: true, render: { visible: false } }),
            Bodies.rectangle(W + wallThickness / 2, H / 2, wallThickness, H * 2, { isStatic: true, render: { visible: false } }),
        ];

        Composite.add(engine.world, wallBodies);
    }

    // ============================================================
    // レールの追加（ストロークデータ → 物理ボディ）
    // ============================================================
    function addRails(normalizedStrokes) {
        var W = window.innerWidth;
        var H = window.innerHeight;

        normalizedStrokes.forEach(function (stroke) {
            // 正規化座標を画面座標に変換
            var screenPoints = stroke.points.map(function (p) {
                return { x: p.x * W, y: p.y * H };
            });

            var lineWidth = stroke.width * W;
            if (lineWidth < 4) lineWidth = 4;

            var segmentBodies = [];

            // 各セグメントを矩形の静的ボディとして生成
            for (var i = 0; i < screenPoints.length - 1; i++) {
                var p1 = screenPoints[i];
                var p2 = screenPoints[i + 1];

                var dx = p2.x - p1.x;
                var dy = p2.y - p1.y;
                var length = Math.sqrt(dx * dx + dy * dy);
                if (length < 2) continue;

                var angle = Math.atan2(dy, dx);
                var centerX = (p1.x + p2.x) / 2;
                var centerY = (p1.y + p2.y) / 2;

                var body = Bodies.rectangle(centerX, centerY, length + 2, RAIL_THICKNESS, {
                    isStatic: true,
                    angle: angle,
                    friction: 0.3,
                    restitution: 0.2,
                    render: { visible: false },
                    label: 'rail',
                });

                segmentBodies.push(body);
            }

            if (segmentBodies.length > 0) {
                Composite.add(engine.world, segmentBodies);
                railBodies.push({
                    bodies: segmentBodies,
                    stroke: {
                        points: screenPoints,
                        color: stroke.color,
                        width: lineWidth,
                    },
                });
            }
        });

        // レール登場エフェクト
        showRailFlash();
    }

    function showRailFlash() {
        var el = document.createElement('div');
        el.className = 'rail-flash';
        course.appendChild(el);
        setTimeout(function () { el.remove(); }, 400);
    }

    // ============================================================
    // 球の投入
    // ============================================================
    function dropBall() {
        var W = window.innerWidth;
        var x = ballDropX * W;
        var y = 20;

        var ball = Bodies.circle(x, y, BALL_RADIUS, {
            restitution: 0.4,
            friction: 0.05,
            density: 0.002,
            label: 'ball',
        });

        Composite.add(engine.world, [ball]);
        balls.push(ball);
    }

    // ============================================================
    // ゴール判定（底面到達）
    // ============================================================
    function checkGoal() {
        var H = window.innerHeight;
        for (var i = balls.length - 1; i >= 0; i--) {
            var ball = balls[i];
            if (ball.position.y > H + BALL_RADIUS * 2) {
                // 底面を超えた → ゴール
                showGoalEffect(ball.position.x);
                Composite.remove(engine.world, ball);
                balls.splice(i, 1);
            }
        }
    }

    function showGoalEffect(x) {
        var el = document.createElement('div');
        el.className = 'goal-effect';
        el.style.left = x + 'px';
        course.appendChild(el);
        setTimeout(function () { el.remove(); }, 800);
    }

    // ============================================================
    // 球投入マーカーのドラッグ
    // ============================================================
    function setupMarkerDrag() {
        var isDragging = false;

        ballMarker.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            isDragging = true;
            ballMarker.setPointerCapture(e.pointerId);
        });

        document.addEventListener('pointermove', function (e) {
            if (!isDragging) return;
            var W = window.innerWidth;
            var x = Math.max(BALL_RADIUS, Math.min(W - BALL_RADIUS, e.clientX));
            ballDropX = x / W;
            ballMarker.style.left = x + 'px';
            ballMarker.style.transform = 'translateX(-50%)';
        });

        document.addEventListener('pointerup', function () {
            isDragging = false;
        });
    }

    // ============================================================
    // コントロール
    // ============================================================
    function setupControls() {
        dropBallBtn.addEventListener('click', function () {
            dropBall();
        });

        clearRailsBtn.addEventListener('click', function () {
            clearAllRails();
        });

        exitBtn.addEventListener('click', function () {
            exitCourse();
        });
    }

    function clearAllRails() {
        // 全レールボディを削除
        railBodies.forEach(function (rail) {
            Composite.remove(engine.world, rail.bodies);
        });
        railBodies = [];

        // 全球も削除
        balls.forEach(function (ball) {
            Composite.remove(engine.world, ball);
        });
        balls = [];
    }

    function exitCourse() {
        isRunning = false;

        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();

        stopAutoMode();
        cancelAnimationFrame(animationId);
        window.removeEventListener('resize', onResize);

        // 物理エンジンクリア
        if (engine) {
            Composite.clear(engine.world);
            Engine.clear(engine);
        }
        railBodies = [];
        balls = [];
        wallBodies = [];

        course.style.display = 'none';
        lobby.style.display = 'flex';
    }

    // ============================================================
    // 自動モード
    // ============================================================
    function startAutoMode() {
        autoIndicator.style.display = 'block';
        autoCountdown = autoInterval;
        updateCountdownDisplay();

        countdownTimerId = setInterval(function () {
            autoCountdown--;
            if (autoCountdown <= 0) {
                dropBall();
                autoCountdown = autoInterval;
            }
            updateCountdownDisplay();
        }, 1000);
    }

    function stopAutoMode() {
        if (countdownTimerId) {
            clearInterval(countdownTimerId);
            countdownTimerId = null;
        }
        autoIndicator.style.display = 'none';
    }

    function updateCountdownDisplay() {
        autoCountdownEl.textContent = autoCountdown;
    }

    // ============================================================
    // 描画
    // ============================================================
    function drawRails() {
        railBodies.forEach(function (rail) {
            var stroke = rail.stroke;
            var points = stroke.points;
            if (points.length < 2) return;

            ctx.save();
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

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
                ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
            }

            ctx.stroke();
            ctx.restore();
        });
    }

    function drawBalls() {
        balls.forEach(function (ball) {
            var pos = ball.position;
            ctx.save();

            // ボールの影
            ctx.beginPath();
            ctx.arc(pos.x + 2, pos.y + 2, BALL_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            ctx.fill();

            // ボール本体（グラデーション）
            var grad = ctx.createRadialGradient(
                pos.x - BALL_RADIUS * 0.3, pos.y - BALL_RADIUS * 0.3, BALL_RADIUS * 0.1,
                pos.x, pos.y, BALL_RADIUS
            );
            grad.addColorStop(0, '#ff7675');
            grad.addColorStop(0.7, '#d63031');
            grad.addColorStop(1, '#a01010');

            ctx.beginPath();
            ctx.arc(pos.x, pos.y, BALL_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            // ハイライト
            ctx.beginPath();
            ctx.arc(pos.x - BALL_RADIUS * 0.25, pos.y - BALL_RADIUS * 0.25, BALL_RADIUS * 0.35, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fill();

            ctx.restore();
        });
    }

    // ============================================================
    // アニメーションループ
    // ============================================================
    var lastTime = 0;

    function animate(timestamp) {
        if (!isRunning) return;
        animationId = requestAnimationFrame(animate);

        if (!timestamp) timestamp = performance.now();
        var dt = lastTime ? Math.min(timestamp - lastTime, 50) : 16.67;
        lastTime = timestamp;

        // 物理エンジン更新
        Engine.update(engine, dt);

        // ゴール判定
        checkGoal();

        // 描画
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawRails();
        drawBalls();
    }

    // ============================================================
    // 初期化
    // ============================================================
    setupPeer();

})();
