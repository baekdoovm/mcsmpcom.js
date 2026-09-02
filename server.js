const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Render 설정
// ============================================================

const PORT = process.env.PORT || 3000;

// Render Persistent Disk를 /data에 연결하면
// DB_PATH=/data/db.json 사용 가능
const DB_PATH =
    process.env.DB_PATH ||
    path.join(__dirname, "data", "db.json");


// ============================================================
// 계정
// ============================================================

// 관리자
const ADMIN_NAME = "baekdoo";
const ADMIN_CODE = "bk100346";

// 친구
const FRIEND_CODES = {
    "SideBloom557332": "GGNSB5733",
    "kim1111434": "DOGY143",
    "TaTa95v": "PHY9595",
    "Junhun1011": "JHKY1011",
    "YSJ": "LK0202",
    "LCH": "HCLC2103"
};


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
            posts: Array.isArray(parsed.posts)
                ? parsed.posts
                : [],

            messages: Array.isArray(parsed.messages)
                ? parsed.messages
                : []
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

function parseCookieHeader(header) {
    const cookies = {};

    if (!header) {
        return cookies;
    }

    header.split(";").forEach(part => {
        const index = part.indexOf("=");

        if (index === -1) {
            return;
        }

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();

        cookies[key] = decodeURIComponent(value);
    });

    return cookies;
}

function getUserFromRequest(req) {
    const cookies =
        parseCookieHeader(req.headers.cookie);

    const token = cookies.mcsmp_session;

    if (!token) {
        return null;
    }

    return sessions.get(token) || null;
}


// ============================================================
// 인증 미들웨어
// ============================================================

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
    const code =
        String(req.body.code || "").trim();

    if (!code) {
        return res.status(400).json({
            success: false,
            message: "입장코드를 입력하세요."
        });
    }


    // --------------------------------------------------------
    // 관리자
    // --------------------------------------------------------

    if (code === ADMIN_CODE) {
        const token = generateToken();

        sessions.set(token, {
            name: ADMIN_NAME,
            admin: true,
            loginAt: Date.now()
        });

        res.setHeader(
            "Set-Cookie",
            `mcsmp_session=${token}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
        );

        return res.json({
            success: true,
            name: ADMIN_NAME,
            admin: true
        });
    }


    // --------------------------------------------------------
    // 친구
    // --------------------------------------------------------

    for (const [name, friendCode] of Object.entries(FRIEND_CODES)) {

        if (code === friendCode) {

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


    // --------------------------------------------------------
    // 실패
    // --------------------------------------------------------

    return res.status(401).json({
        success: false,
        message: "잘못된 입장코드입니다."
    });
});


// ============================================================
// 로그아웃
// ============================================================

app.post("/api/logout", (req, res) => {

    const cookies =
        parseCookieHeader(req.headers.cookie);

    const token =
        cookies.mcsmp_session;

    if (token) {
        sessions.delete(token);
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

    const user =
        getUserFromRequest(req);

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

    const posts =
        [...db.posts].sort(
            (a, b) =>
                b.createdAt - a.createdAt
        );

    res.json(posts);
});


app.post("/api/posts", requireLogin, (req, res) => {

    const title =
        String(req.body.title || "").trim();

    const content =
        String(req.body.content || "").trim();


    if (!title || !content) {

        return res.status(400).json({
            success: false,
            message: "제목과 내용을 입력하세요."
        });

    }


    if (title.length > 100) {

        return res.status(400).json({
            success: false,
            message: "제목은 100자 이하로 입력하세요."
        });

    }


    if (content.length > 10000) {

        return res.status(400).json({
            success: false,
            message: "내용은 10000자 이하로 입력하세요."
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


// ============================================================
// 게시글 삭제
// 관리자 전용
// ============================================================

app.delete(
    "/api/posts/:id",
    requireAdmin,
    (req, res) => {

        const index =
            db.posts.findIndex(
                post =>
                    post.id === req.params.id
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

    }
);


// ============================================================
// 채팅 API
// ============================================================

app.get(
    "/api/messages",
    requireLogin,
    (req, res) => {

        res.json(
            db.messages.slice(-100)
        );

    }
);


// ============================================================
// Socket.IO 인증
// ============================================================

io.use((socket, next) => {

    const cookies =
        parseCookieHeader(
            socket.handshake.headers.cookie
        );


    const token =
        cookies.mcsmp_session;


    if (!token) {

        return next(
            new Error(
                "로그인이 필요합니다."
            )
        );

    }


    const user =
        sessions.get(token);


    if (!user) {

        return next(
            new Error(
                "세션이 만료되었습니다."
            )
        );

    }


    socket.user = user;

    next();

});


// ============================================================
// Socket.IO
// ============================================================

io.on("connection", socket => {

    console.log(
        `[접속] ${socket.user.name}`
    );


    // 최근 메시지
    socket.emit(
        "chat:init",
        db.messages.slice(-100)
    );


    // 접속자 업데이트
    io.emit(
        "online:update",
        getOnlineUsers()
    );


    // --------------------------------------------------------
    // 메시지 전송
    // --------------------------------------------------------

    socket.on("chat:send", data => {

        let content = "";


        if (typeof data === "string") {

            content = data.trim();

        } else {

            content =
                String(
                    data?.content || ""
                ).trim();

        }


        if (!content) {
            return;
        }


        if (content.length > 1000) {

            socket.emit(
                "chat:error",
                {
                    message:
                        "메시지는 1000자 이하로 입력하세요."
                }
            );

            return;

        }


        const message = {

            id: crypto.randomUUID(),

            author:
                socket.user.name,

            content,

            createdAt:
                Date.now()

        };


        db.messages.push(message);


        // 최근 1000개만 유지
        if (db.messages.length > 1000) {

            db.messages =
                db.messages.slice(-1000);

        }


        saveDB();


        // 모든 접속자에게 즉시 전송
        io.emit(
            "chat:new",
            message
        );

    });


    // --------------------------------------------------------
    // 채팅 삭제
    // --------------------------------------------------------

    socket.on("chat:delete", id => {

        if (!socket.user.admin) {
            return;
        }


        const index =
            db.messages.findIndex(
                message =>
                    message.id === id
            );


        if (index === -1) {
            return;
        }


        db.messages.splice(index, 1);

        saveDB();


        io.emit(
            "chat:deleted",
            id
        );

    });


    // --------------------------------------------------------
    // 접속 종료
    // --------------------------------------------------------

    socket.on("disconnect", () => {

        console.log(
            `[퇴장] ${socket.user.name}`
        );


        io.emit(
            "online:update",
            getOnlineUsers()
        );

    });

});


// ============================================================
// 접속자
// ============================================================

function getOnlineUsers() {

    const users = [];


    for (
        const socket
        of io.sockets.sockets.values()
    ) {

        if (socket.user) {

            users.push(
                socket.user.name
            );

        }

    }


    return [
        ...new Set(users)
    ];

}


app.get(
    "/api/online",
    requireLogin,
    (req, res) => {

        res.json(
            getOnlineUsers()
        );

    }
);


// ============================================================
// HTML 제공
// ============================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


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
// 서버 시작
// ============================================================

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "======================================"
        );

        console.log(
            "MCSMP Community Server"
        );

        console.log(
            `Port: ${PORT}`
        );

        console.log(
            `Database: ${DB_PATH}`
        );

        console.log(
            "======================================"
        );

    }
);
