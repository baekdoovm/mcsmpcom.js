const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// 설정
// ============================================================

const PORT = process.env.PORT || 3000;

// Render Persistent Disk를 사용하는 경우 /data/db.json
// 로컬에서는 ./data/db.json 사용
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "db.json");

// 관리자 입장코드
// Render 환경변수 ADMIN_CODE에 넣는 것을 권장
const ADMIN_CODE = process.env.ADMIN_CODE || "CHANGE_THIS_ADMIN_CODE";

// 친구별 입장코드
//
// Render 환경변수:
// FRIEND_CODES_JSON={"친구1":"1234","친구2":"5678"}
//
// 서버에서만 읽기 때문에 HTML에 코드가 노출되지 않는다.
let FRIEND_CODES = {};

try {
    if (process.env.FRIEND_CODES_JSON) {
        FRIEND_CODES = JSON.parse(process.env.FRIEND_CODES_JSON);
    }
} catch (error) {
    console.error("FRIEND_CODES_JSON을 읽을 수 없습니다.");
    console.error(error);
}

// ============================================================
// DB
// ============================================================

function ensureDatabase() {
    const dir = path.dirname(DB_PATH);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(
            DB_PATH,
            JSON.stringify(
                {
                    posts: [],
                    messages: []
                },
                null,
                2
            ),
            "utf8"
        );
    }
}

ensureDatabase();

function loadDB() {
    try {
        const data = fs.readFileSync(DB_PATH, "utf8");
        const parsed = JSON.parse(data);

        return {
            posts: Array.isArray(parsed.posts) ? parsed.posts : [],
            messages: Array.isArray(parsed.messages) ? parsed.messages : []
        };
    } catch (error) {
        console.error("DB 읽기 실패:", error);

        return {
            posts: [],
            messages: []
        };
    }
}

let db = loadDB();

let saveTimer = null;

function saveDB() {
    clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
        try {
            const tempPath = DB_PATH + ".tmp";

            fs.writeFileSync(
                tempPath,
                JSON.stringify(db, null, 2),
                "utf8"
            );

            fs.renameSync(tempPath, DB_PATH);

        } catch (error) {
            console.error("DB 저장 실패:", error);
        }
    }, 100);
}

// ============================================================
// 세션
// ============================================================

const sessions = new Map();

function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

function parseCookies(req) {
    const cookies = {};

    const header = req.headers.cookie;

    if (!header) {
        return cookies;
    }

    header.split(";").forEach(part => {
        const index = part.indexOf("=");

        if (index === -1) return;

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        cookies[key] = decodeURIComponent(value);
    });

    return cookies;
}

function getUserFromRequest(req) {
    const cookies = parseCookies(req);

    if (!cookies.mcsmp_session) {
        return null;
    }

    return sessions.get(cookies.mcsmp_session) || null;
}

function requireLogin(req, res, next) {
    const user = getUserFromRequest(req);

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "로그인이 필요합니다."
        });
    }

    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const user = getUserFromRequest(req);

    if (!user || !user.admin) {
        return res.status(403).json({
            success: false,
            message: "관리자만 사용할 수 있습니다."
        });
    }

    req.user = user;
    next();
}

// ============================================================
// 로그인
// ============================================================

app.post("/api/login", (req, res) => {
    const code = String(req.body.code || "").trim();

    if (!code) {
        return res.status(400).json({
            success: false,
            message: "입장코드를 입력하세요."
        });
    }

    // 관리자
    if (code === ADMIN_CODE) {
        const token = generateToken();

        sessions.set(token, {
            name: "관리자",
            admin: true,
            loginAt: Date.now()
        });

        res.cookie = res.cookie || function () {};

        res.setHeader(
            "Set-Cookie",
            `mcsmp_session=${token}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
        );

        return res.json({
            success: true,
            name: "관리자",
            admin: true
        });
    }

    // 친구 코드
    for (const [name, friendCode] of Object.entries(FRIEND_CODES)) {
        if (String(friendCode) === code) {
            const token = generateToken();

            sessions.set(token, {
                name,
                admin: false,
                loginAt: Date.now()
            });

            res.setHeader(
                "Set-Cookie",
                `mcsmp_session=${token}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
            );

            return res.json({
                success: true,
                name,
                admin: false
            });
        }
    }

    return res.status(401).json({
        success: false,
        message: "잘못된 입장코드입니다."
    });
});

// ============================================================
// 로그아웃
// ============================================================

app.post("/api/logout", (req, res) => {
    const cookies = parseCookies(req);

    if (cookies.mcsmp_session) {
        sessions.delete(cookies.mcsmp_session);
    }

    res.setHeader(
        "Set-Cookie",
        "mcsmp_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax"
    );

    res.json({
        success: true
    });
});

// ============================================================
// 현재 사용자
// ============================================================

app.get("/api/me", (req, res) => {
    const user = getUserFromRequest(req);

    if (!user) {
        return res.json({
            loggedIn: false
        });
    }

    res.json({
        loggedIn: true,
        name: user.name,
        admin: user.admin
    });
});

// ============================================================
// 게시판
// ============================================================

app.get("/api/posts", requireLogin, (req, res) => {
    const posts = [...db.posts].sort(
        (a, b) => b.createdAt - a.createdAt
    );

    res.json(posts);
});

app.post("/api/posts", requireLogin, (req, res) => {
    const title = String(req.body.title || "").trim();
    const content = String(req.body.content || "").trim();

    if (!title || !content) {
        return res.status(400).json({
            success: false,
            message: "제목과 내용을 입력하세요."
        });
    }

    if (title.length > 100) {
        return res.status(400).json({
            success: false,
            message: "제목이 너무 깁니다."
        });
    }

    if (content.length > 10000) {
        return res.status(400).json({
            success: false,
            message: "내용이 너무 깁니다."
        });
    }

    const post = {
        id: crypto.randomUUID(),
        title,
        content,
        author: req.user.name,
        createdAt: Date.now()
    };

    db.posts.push(post);
    saveDB();

    res.json({
        success: true,
        post
    });
});

// 게시글 삭제
app.delete("/api/posts/:id", requireAdmin, (req, res) => {
    const index = db.posts.findIndex(
        post => post.id === req.params.id
    );

    if (index === -1) {
        return res.status(404).json({
            success: false,
            message: "게시글을 찾을 수 없습니다."
        });
    }

    db.posts.splice(index, 1);
    saveDB();

    res.json({
        success: true
    });
});

// ============================================================
// 채팅
// ============================================================

app.get("/api/messages", requireLogin, (req, res) => {
    res.json(db.messages.slice(-100));
});

// ============================================================
// Socket.IO 인증
// ============================================================

io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;

    if (!cookieHeader) {
        return next(new Error("로그인이 필요합니다."));
    }

    const cookies = {};

    cookieHeader.split(";").forEach(part => {
        const index = part.indexOf("=");

        if (index === -1) return;

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        cookies[key] = decodeURIComponent(value);
    });

    const token = cookies.mcsmp_session;

    if (!token) {
        return next(new Error("로그인이 필요합니다."));
    }

    const user = sessions.get(token);

    if (!user) {
        return next(new Error("세션이 만료되었습니다."));
    }

    socket.user = user;

    next();
});

// ============================================================
// 실시간 채팅
// ============================================================

io.on("connection", socket => {
    console.log(`${socket.user.name} 접속`);

    socket.emit("chat:init", db.messages.slice(-100));

    io.emit("online:update", getOnlineUsers());

    socket.on("chat:send", data => {
        let content = "";

        if (typeof data === "string") {
            content = data.trim();
        } else {
            content = String(data?.content || "").trim();
        }

        if (!content) return;

        if (content.length > 1000) {
            socket.emit("chat:error", {
                message: "메시지가 너무 깁니다."
            });

            return;
        }

        const message = {
            id: crypto.randomUUID(),
            author: socket.user.name,
            content,
            createdAt: Date.now()
        };

        db.messages.push(message);

        // 채팅 DB는 최근 1000개만 유지
        if (db.messages.length > 1000) {
            db.messages = db.messages.slice(-1000);
        }

        saveDB();

        io.emit("chat:new", message);
    });

    // 관리자 채팅 삭제
    socket.on("chat:delete", id => {
        if (!socket.user.admin) {
            return;
        }

        const index = db.messages.findIndex(
            message => message.id === id
        );

        if (index === -1) {
            return;
        }

        db.messages.splice(index, 1);
        saveDB();

        io.emit("chat:deleted", id);
    });

    socket.on("disconnect", () => {
        console.log(`${socket.user.name} 퇴장`);

        io.emit("online:update", getOnlineUsers());
    });
});

// ============================================================
// 접속자
// ============================================================

function getOnlineUsers() {
    const users = [];

    for (const socket of io.sockets.sockets.values()) {
        if (socket.user) {
            users.push(socket.user.name);
        }
    }

    return [...new Set(users)];
}

app.get("/api/online", requireLogin, (req, res) => {
    res.json(getOnlineUsers());
});

// ============================================================
// 정적 파일
// ============================================================

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "페이지를 찾을 수 없습니다."
    });
});

// ============================================================
// 서버 실행
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
    console.log("====================================");
    console.log("MCSMP Community Server");
    console.log(`Port: ${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log("====================================");
});
