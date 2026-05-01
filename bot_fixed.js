// ==================== AUTO INSTALLER ====================
(function() {
    const { execSync } = require('child_process');
    const required = ['telegraf', 'axios', 'fs-extra', 'uuid', 'node-cron', 'dotenv'];
    const missing = [];
    for (const mod of required) {
        try { require.resolve(mod); } catch (e) { missing.push(mod); }
    }
    if (missing.length > 0) {
        console.log('⚠️ Menginstall: ' + missing.join(', '));
        const attempts = [
            'npm install ' + missing.join(' ') + ' --prefer-offline --no-audit --no-fund',
            'npm install ' + missing.join(' ') + ' --no-audit --no-fund',
            'npm install ' + missing.join(' '),
        ];
        let installed = false;
        for (const cmd of attempts) {
            try {
                execSync(cmd, { stdio: 'inherit', timeout: 120000 });
                installed = true;
                break;
            } catch(e) { continue; }
        }
        if (installed) {
            console.log('✅ Install selesai. Restart bot...');
            process.exit(0);
        } else {
            console.warn('⚠️ Install gagal, mencoba lanjut dengan module yang ada...');
        }
    }
})();

// ==================== IMPORT ====================
require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const path    = require('path');
const cron    = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const fs      = require('fs-extra');
const { fork, spawn } = require('child_process');

const __rootDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(process.argv[1] || '.');

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN belum diset!\nBuat file .env dan isi:\nBOT_TOKEN=token_bot_kamu\nOWNER_ID=user_id_kamu');
    process.exit(1);
}

const OWNER_ID    = process.env.OWNER_ID ? parseInt(process.env.OWNER_ID) : 0;
const BOT_VERSION = '5.2.0';
const WATERMARK   = '\n\n💧 *Powered by Store Bot v5.2*\n🤖 _by @bujajg_';
const GRUP_WATERMARK = '\n\n🤖 _by @bujajg_';

const DATA_ROOT = path.join(__rootDir, 'data');
const DB_PATH   = path.join(DATA_ROOT, 'db');
[DATA_ROOT, DB_PATH].forEach(d => fs.ensureDirSync(d));

// ==================== DB FILES ====================
const DB = {
    config:              path.join(DATA_ROOT, 'config.json'),
    qris:                path.join(DB_PATH, 'qris.json'),
    categories:          path.join(DB_PATH, 'categories.json'),
    products:            path.join(DB_PATH, 'products.json'),
    plans:               path.join(DB_PATH, 'plans.json'),
    customers:           path.join(DB_PATH, 'customers.json'),
    orders:              path.join(DB_PATH, 'orders.json'),
    admins:              path.join(DB_PATH, 'admins.json'),
    announcements:       path.join(DB_PATH, 'announcements.json'),
    blocked_users:       path.join(DB_PATH, 'blocked_users.json'),
    groups:              path.join(DB_PATH, 'groups.json'),
    group_warns:         path.join(DB_PATH, 'group_warns.json'),
    group_rules:         path.join(DB_PATH, 'group_rules.json'),
    group_notes:         path.join(DB_PATH, 'group_notes.json'),
    group_mutes:         path.join(DB_PATH, 'group_mutes.json'),
    group_welcome:       path.join(DB_PATH, 'group_welcome.json'),
    akun_stok:           path.join(DB_PATH, 'akun_stok.json'),
    clones:              path.join(DB_PATH, 'clones.json'),
    clone_subscriptions: path.join(DB_PATH, 'clone_subscriptions.json'),
    monitoring:          path.join(DB_PATH, 'monitoring.json'),
    rnk_pending:         path.join(DB_PATH, 'rnk_pending.json'),
};

let defaultConfig = {
    name: 'Store Bot', botToken: BOT_TOKEN, ownerId: OWNER_ID,
    timezone: 'Asia/Jakarta', currency: 'IDR', maintenance: false,
    version: BOT_VERSION, createdAt: new Date().toISOString(),
    aiEnabled: false, aiKey: '', aiModel: 'mistral-small-latest',
    aiPrompt: '', aiGroupEnabled: false, aiGroupFull: false
};
if (fs.existsSync(DB.config)) { defaultConfig = { ...defaultConfig, ...fs.readJsonSync(DB.config) }; }
else { fs.writeJsonSync(DB.config, defaultConfig, { spaces: 2 }); }
let config = defaultConfig;

Object.entries(DB).forEach(([k, f]) => {
    if (k === 'config') return;
    if (!fs.existsSync(f)) fs.writeJsonSync(f, [], { spaces: 2 });
});

// ==================== DB HELPERS ====================
const db = {
    read:   (file) => { try { return fs.readJsonSync(file); } catch(e) { return []; } },
    write:  (file, data) => fs.writeJsonSync(file, data, { spaces: 2 }),
    find:   (file, fn) => db.read(file).find(fn),
    filter: (file, fn) => db.read(file).filter(fn),
    push:   (file, item) => { const arr = db.read(file); arr.push(item); db.write(file, arr); return item; },
    update: (file, fn, updater) => {
        const arr = db.read(file); const idx = arr.findIndex(fn);
        if (idx !== -1) { updater(arr[idx]); db.write(file, arr); return arr[idx]; } return null;
    },
    remove: (file, fn) => {
        const arr = db.read(file); const f = arr.filter(i => !fn(i));
        db.write(file, f); return arr.length - f.length;
    },
    upsert: (file, fn, data) => {
        const arr = db.read(file); const idx = arr.findIndex(fn);
        if (idx !== -1) { arr[idx] = { ...arr[idx], ...data }; db.write(file, arr); return arr[idx]; }
        else { arr.push({ ...data }); db.write(file, arr); return data; }
    }
};

// ==================== BOT INIT ====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ defaultSession: () => ({ cart: { items: [], total: 0 }, action: null }) }));

// ==================== UTILS ====================
function isOwner(id)         { return config.ownerId === id || config.ownerId === String(id); }
function isAdmin(id)         { return db.find(DB.admins, a => a.id === id && a.aktif !== false) !== undefined; }
function isAdminOrOwner(id)  { return isOwner(id) || isAdmin(id); }
function isBlocked(id)       { return db.find(DB.blocked_users, b => b.userId === id) !== undefined; }
function formatRp(n)         { return `Rp${Number(n).toLocaleString('id-ID')}`; }
function formatDate(d)       { return new Date(d).toLocaleString('id-ID', { timeZone: config.timezone }); }
function formatDateShort(d)  { return new Date(d).toLocaleDateString('id-ID', { timeZone: config.timezone }); }
function genInvoiceId(uid)   { return `INV-${Date.now().toString(36).toUpperCase()}-${String(uid).slice(-4)}`; }
function genCode(prefix='CODE') { return `${prefix}${Math.random().toString(36).slice(2,8).toUpperCase()}`; }
function isGroup(ctx)        { return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'); }
function isPrivate(ctx)      { return ctx.chat && ctx.chat.type === 'private'; }

function isCloneExpired(botName) {
    const sub = db.find(DB.clone_subscriptions, s => s.botName === botName);
    if (!sub) return false;
    return new Date(sub.expiredAt) < new Date();
}
function sisaHariClone(botName) {
    const sub = db.find(DB.clone_subscriptions, s => s.botName === botName);
    if (!sub) return null;
    return Math.max(0, Math.ceil((new Date(sub.expiredAt) - new Date()) / 86400000));
}

function registerCustomer(ctx) {
    if (!ctx.from) return;
    const existing = db.find(DB.customers, c => c.id === ctx.from.id);
    if (!existing) {
        db.push(DB.customers, {
            id: ctx.from.id, username: ctx.from.username,
            first_name: ctx.from.first_name, last_name: ctx.from.last_name,
            joinDate: new Date().toISOString(), totalBelanja: 0, totalOrder: 0,
            lastSeen: new Date().toISOString()
        });
    } else {
        db.update(DB.customers, c => c.id === ctx.from.id, c => { c.lastSeen = new Date().toISOString(); });
    }
}

async function sendToAdmins(msg, opts = {}) {
    const admins = db.read(DB.admins);
    for (const adm of admins) {
        try { await bot.telegram.sendMessage(adm.id, msg, { parse_mode: 'Markdown', ...opts }); } catch(e) {}
    }
    if (config.ownerId) {
        try { await bot.telegram.sendMessage(config.ownerId, msg, { parse_mode: 'Markdown', ...opts }); } catch(e) {}
    }
}

async function safeAnswerCbQuery(ctx, text = '', showAlert = false) {
    try { await ctx.answerCbQuery(text, { show_alert: showAlert }); } catch(e) {}
}
async function safeEditMessage(ctx, text, extra = {}) {
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); }
    catch(e) { try { await ctx.reply(text, { parse_mode: 'Markdown', ...extra }); } catch(e2) {} }
}
function escapeMd(text) {
    return String(text).replace(/[-_.!*`[\]()~>#+=|{}.]/g, '\\$&');
}
async function getGroupAdmins(chatId) {
    try { const admins = await bot.telegram.getChatAdministrators(chatId); return admins.filter(a => !a.user.is_bot); }
    catch(e) { return []; }
}
async function isGroupAdmin(ctx) {
    const admins = await getGroupAdmins(ctx.chat.id);
    return !!admins.find(a => a.user.id === ctx.from.id);
}
async function getMention(user) {
    if (user.username) return `@${user.username}`;
    return `[${user.first_name || user.id}](tg://user?id=${user.id})`;
}

// ==================== AKUN STOK ====================
function hitungStokAkun(planId) {
    try { return db.read(DB.akun_stok).filter(a => a.planId === planId && !a.used).length; } catch(e) { return 0; }
}

// Cek apakah produk berjenis manual (diamond/joki/manual) — tidak pakai akun_stok
const MANUAL_KEYWORDS = ['diamond', 'joki', 'manual', 'topup', 'top up', 'top-up'];
function isManualProduct(planId) {
    try {
        const plan = db.find(DB.plans, p => p.id === planId);
        if (!plan) return false;
        const prod = db.find(DB.products, p => p.id === plan.produk_id);
        const haystack = ((plan.nama || '') + ' ' + (prod?.nama || '') + ' ' + (prod?.kategori || '')).toLowerCase();
        return MANUAL_KEYWORDS.some(kw => haystack.includes(kw));
    } catch(e) { return false; }
}
function ambilAkunDariStok(planId, orderId) {
    const stok = db.read(DB.akun_stok);
    const idx  = stok.findIndex(a => a.planId === planId && !a.used);
    if (idx === -1) return null;
    stok[idx].used = true; stok[idx].orderId = orderId; stok[idx].usedAt = new Date().toISOString();
    db.write(DB.akun_stok, stok);
    return stok[idx].akun;
}
function tambahBulkAkun(planId, listAkun) {
    const stok = db.read(DB.akun_stok);
    const added = [];
    const seenInBatch = new Set();
    let dupInBatch = 0;
    let dupOfExisting = 0;

    for (const akun of listAkun) {
        const t = akun.trim();
        if (!t) continue;
        // Cek duplikat dalam batch input ini
        const isDupInBatch = seenInBatch.has(t);
        if (isDupInBatch) dupInBatch++;
        seenInBatch.add(t);
        // Cek apakah akun ini sudah ada di stok yang belum terpakai
        const sudahAdaDiStok = !!stok.find(s => s.akun === t && s.planId === planId && !s.used);
        if (sudahAdaDiStok) dupOfExisting++;
        // Tetap masukkan semua ke stok (duplikat diizinkan)
        const item = {
            id: `AKN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`,
            planId, akun: t, used: false, orderId: null, usedAt: null,
            addedAt: new Date().toISOString(),
            dupFlag: isDupInBatch ? 'batch' : sudahAdaDiStok ? 'existing' : null
        };
        stok.push(item);
        added.push(item);
    }
    db.write(DB.akun_stok, stok);
    return { added, dupInBatch, dupOfExisting };
}

async function autoDeliveryAkun(ctx, order) {
    try {
        // Cek apakah semua item adalah produk manual (diamond/joki/dll)
        const allManual = (order.items || []).every(item => isManualProduct(item.planId));
        if (allManual) {
            // Produk manual: notif admin untuk kirim pesan ke customer, tidak perlu format akun
            await sendToAdmins(
                `🔧 *ORDER MANUAL — PERLU DIKIRIM!*\n\n🆔 Order: \`${order.id}\`\n👤 ${order.customerName} (@${order.username || '-'})\n💰 ${formatRp(order.total)}\n\n📦 *Item:*\n${(order.items||[]).map(i=>`• ${i.planNama}`).join('\n')}\n\n_Kirim pesan/konfirmasi ke customer:_`,
                { reply_markup: { inline_keyboard: [[{ text: '💬 Kirim ke Customer', callback_data: `kirim_manual_${order.id}` }]] } }
            );
            return false; // false = perlu aksi admin
        }

        const akunList = [];
        for (const item of (order.items || [])) {
            for (let i = 0; i < (item.qty || 1); i++) {
                const akun = ambilAkunDariStok(item.planId, order.id);
                if (akun) akunList.push({ planNama: item.planNama || item.planId, akun });
            }
        }
        if (!akunList.length) {
            await sendToAdmins(
                `⚠️ *STOK AKUN HABIS!*\n📦 Order: \`${order.id}\`\n👤 ${order.customerName}\n\nKirim manual:\n/kirim_akun ${order.userId} [akun]`,
                { reply_markup: { inline_keyboard: [[{ text: '📤 Kirim Akun Manual', callback_data: `kirim_manual_${order.id}` }]] } }
            );
            return false;
        }
        let msg = `🎉 *AKUN ANDA SUDAH SIAP!*\n\n🆔 Order: \`${order.id}\`\n${'━'.repeat(22)}\n\n`;
        akunList.forEach(a => { msg += `📦 *${a.planNama}*\n\`\`\`\n${a.akun}\n\`\`\`\n\n`; });
        msg += `${'━'.repeat(22)}\n🔒 _Jangan bagikan ke siapapun!_`;
        const botInfo = await bot.telegram.getMe().catch(() => ({ username: 'bot' }));
        await bot.telegram.sendMessage(order.userId, msg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❓ Ada Masalah? Hubungi Admin', url: `https://t.me/${botInfo.username}` }]] }
        });
        await sendToAdmins(`✅ *AUTO DELIVERY OK*\n📦 \`${order.id}\`\n👤 ${order.customerName} (@${order.username || '-'})`);
        return true;
    } catch(e) { console.error('[AutoDelivery]', e.message); return false; }
}

// ==================== KATA KASAR ====================
const KATA_KASAR = ['anjing', 'babi', 'bangsat', 'bajingan', 'kontol', 'memek', 'jancok', 'asu', 'goblok', 'tolol', 'brengsek', 'keparat'];

// ==================== KEYBOARDS ====================

function buildMainKeyboard(userId) {
    const kb = { inline_keyboard: [
        [
            { text: '🛍️ Belanja',      callback_data: 'belanja' },
            { text: '🛒 Keranjang',    callback_data: 'lihat_keranjang' }
        ],
        [
            { text: '📋 Riwayat Order', callback_data: 'history_customer' },
            { text: '💳 Cara Bayar',    callback_data: 'menu_cara_bayar' }
        ],
        [
            { text: '📢 Promo',         callback_data: 'menu_promo' },
            { text: '❓ Bantuan',        callback_data: 'help_menu' }
        ],
        [
            { text: '👤 Profil Saya',   callback_data: 'profil_customer' }
        ],
    ]};
    if (isAdminOrOwner(userId)) kb.inline_keyboard.push([{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]);
    if (isOwner(userId))        kb.inline_keyboard.push([{ text: '👑 Owner Panel', callback_data: 'owner_panel' }]);
    return kb;
}

function buildAdminKeyboard() {
    return { inline_keyboard: [
        [
            { text: '⏳ Order Pending',  callback_data: 'admin_orders_pending' },
            { text: '📝 Semua Order',    callback_data: 'admin_orders' }
        ],
        [
            { text: '📦 Produk',         callback_data: 'admin_produk' },
            { text: '🗂️ Kategori',      callback_data: 'admin_kategori' }
        ],
        [
            { text: '📋 Paket',          callback_data: 'admin_plans' },
            { text: '💳 Pembayaran',     callback_data: 'admin_qris' }
        ],
        [
            { text: '📥 Input Akun',     callback_data: 'admin_input_akun' },
            { text: '📦 Stok Akun',      callback_data: 'admin_lihat_stok_akun' }
        ],
        [
            { text: '👥 Pelanggan',      callback_data: 'admin_customers' },
            { text: '📢 Pengumuman',     callback_data: 'admin_announcement' }
        ],
        [
            { text: '📊 Statistik',      callback_data: 'admin_stats' }
        ],
        [
            { text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }
        ],
    ]};
}

function buildOwnerKeyboard() {
    return { inline_keyboard: [
        [
            { text: '⚙️ Admin Panel',       callback_data: 'admin_panel' }
        ],
        [
            { text: '👮 Kelola Admin',       callback_data: 'owner_admins' },
            { text: '🚫 Blocked Users',      callback_data: 'owner_blocked' }
        ],
        [
            { text: '🤖 Buat Clone',         callback_data: 'owner_clone' },
            { text: '📋 List Clone',          callback_data: 'owner_list_clone' }
        ],
        [
            { text: '▶️ Start All Clone',   callback_data: 'owner_start_all' },
            { text: '⏹️ Stop All Clone',    callback_data: 'owner_stop_all' }
        ],
        [
            { text: '🔧 Maintenance ON/OFF', callback_data: 'owner_maintenance' },
            { text: '⚙️ Pengaturan',         callback_data: 'owner_settings' }
        ],
        [
            { text: '📢 Broadcast',          callback_data: 'owner_broadcast' },
            { text: '📊 Laporan',            callback_data: 'owner_report' }
        ],
        [
            { text: '🤖 AI Settings',        callback_data: 'owner_ai_settings' }
        ],
        [
            { text: '🔙 Menu Utama',         callback_data: 'back_to_menu' }
        ],
    ]};
}

function buildGroupManageKeyboard(chatId) {
    return { inline_keyboard: [
        [
            { text: '📣 Tag Admin',      callback_data: `grp_tag_admin_${chatId}` },
            { text: '📢 Pengumuman',     callback_data: `grp_announce_${chatId}` }
        ],
        [
            { text: '🔇 Mute Member',    callback_data: `grp_mute_menu_${chatId}` },
            { text: '🚫 Kick Member',    callback_data: `grp_kick_menu_${chatId}` }
        ],
        [
            { text: '⚠️ Warn Member',   callback_data: `grp_warn_menu_${chatId}` },
            { text: '📜 Rules',          callback_data: `grp_rules_${chatId}` }
        ],
        [
            { text: '👋 Set Welcome',    callback_data: `grp_setwelcome_${chatId}` },
            { text: '📦 List Produk',    callback_data: `grp_list_produk_${chatId}` }
        ],
        [
            { text: '🔗 Anti-Link',      callback_data: `grp_antilink_${chatId}` },
            { text: '🤐 Anti-Kasar',     callback_data: `grp_antikasar_${chatId}` }
        ],
        [
            { text: config && config.aiGroupEnabled ? '🔴 AI Grup Off' : '🟢 AI Grup On', callback_data: `grp_ai_toggle_${chatId}` },
            { text: '📊 Status Grup',    callback_data: `grp_status_${chatId}` }
        ],
        [
            { text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }
        ],
    ]};
}

// ==================== MIDDLEWARE ====================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    if (isBlocked(ctx.from.id) && !isAdminOrOwner(ctx.from.id)) return ctx.reply('🚫 Akun Anda telah diblokir.');
    if (config.maintenance && !isAdminOrOwner(ctx.from.id)) return ctx.reply('🔧 Bot sedang maintenance. Coba lagi nanti.');
    if (isPrivate(ctx)) registerCustomer(ctx);
    await next();
});

// ==================== GRUP: AUTO REGISTER ====================
bot.on('message', async (ctx, next) => {
    if (isGroup(ctx) && ctx.chat) {
        const chatId = String(ctx.chat.id);
        const existing = db.find(DB.groups, g => String(g.chatId) === chatId);
        if (!existing) {
            db.push(DB.groups, {
                chatId,
                title: ctx.chat.title || '',
                antilink: false,
                antikasar: false,
                joinedAt: new Date().toISOString()
            });
        }
    }
    return next();
});

// ==================== GRUP: AUTO FILTER (HARUS SEBELUM text handler lain) ====================
bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx) || !ctx.message) return next();
    const chatId = String(ctx.chat.id);
    const groupSettings = db.find(DB.groups, g => String(g.chatId) === chatId);
    if (!groupSettings) return next();

    const text = ctx.message.text || ctx.message.caption || '';
    const userId = ctx.from?.id;
    if (!userId) return next();

    // Admin grup & admin bot dilewati
    const groupAdmins = await getGroupAdmins(ctx.chat.id);
    const isGA = !!groupAdmins.find(a => a.user.id === userId);
    if (isGA || isAdminOrOwner(userId)) return next();

    // Anti-link
    if (groupSettings.antilink) {
        const urlRegex = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.|bit\.ly)/gi;
        if (urlRegex.test(text)) {
            try { await ctx.deleteMessage(); } catch(e) {}
            const mention = await getMention(ctx.from);
            await ctx.reply(`🚫 ${mention}, dilarang mengirim link di grup ini!${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
            return;
        }
    }

    // Anti-kasar
    if (groupSettings.antikasar) {
        const lower = text.toLowerCase();
        const found = KATA_KASAR.find(k => lower.includes(k));
        if (found) {
            try { await ctx.deleteMessage(); } catch(e) {}
            const mention = await getMention(ctx.from);
            const key = `${chatId}_${userId}`;
            let warnData = db.find(DB.group_warns, w => w.key === key);
            if (!warnData) {
                warnData = { key, chatId, userId, username: ctx.from.username, warns: [] };
                db.push(DB.group_warns, warnData);
            }
            warnData.warns.push({ alasan: 'Kata kasar otomatis', by: 'auto', at: new Date().toISOString() });
            db.update(DB.group_warns, w => w.key === key, w => { w.warns = warnData.warns; });
            const count = warnData.warns.length;
            if (count >= 3) {
                try { await bot.telegram.banChatMember(ctx.chat.id, userId); await bot.telegram.unbanChatMember(ctx.chat.id, userId); } catch(e) {}
                db.update(DB.group_warns, w => w.key === key, w => { w.warns = []; });
                await ctx.reply(`🚫 ${mention} dikick karena 3 peringatan kata kasar!${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`⚠️ ${mention}, kata kasar dilarang! Peringatan *${count}/3*${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
            }
            return;
        }
    }

    return next();
});

// ==================== GRUP: WELCOME MESSAGE ====================
bot.on('new_chat_members', async (ctx) => {
    if (!isGroup(ctx)) return;
    const chatId = String(ctx.chat.id);
    const welcome = db.find(DB.group_welcome, w => String(w.chatId) === String(chatId));
    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot) continue;
        const mention  = member.username ? `@${member.username}` : `[${member.first_name}](tg://user?id=${member.id})`;
        const name     = member.first_name || 'Member';
        const username = member.username || member.first_name || 'member';
        let text = welcome?.text || `👋 Selamat datang {mention} di *${ctx.chat.title}*!\n\nBaca /rules sebelum berdiskusi ya 😊`;
        text = text.replace(/{name}/g, name).replace(/{username}/g, username).replace(/{mention}/g, mention);
        try { await ctx.reply(text + GRUP_WATERMARK, { parse_mode: 'Markdown' }); } catch(e) {}
    }
});

// ==================== START / MENU ====================
bot.start(async (ctx) => {
    if (isGroup(ctx)) return;
    await ctx.reply(
        `🏪 *SELAMAT DATANG DI ${config.name}*\n\n👋 Halo *${ctx.from.first_name}*!\nPilih menu di bawah:${WATERMARK}`,
        { parse_mode: 'Markdown', reply_markup: buildMainKeyboard(ctx.from.id) }
    );
});

bot.command('menu', async (ctx) => {
    if (isGroup(ctx)) {
        await ctx.reply(
            `🏪 *${config.name}*\nOrder produk langsung via DM bot ya!`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛍️ Buka Toko', url: `https://t.me/${(await bot.telegram.getMe()).username}` }]] } }
        );
        return;
    }
    await ctx.reply('🏪 *MAIN MENU*', { parse_mode: 'Markdown', reply_markup: buildMainKeyboard(ctx.from.id) });
});

bot.action('back_to_menu', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEditMessage(ctx, `🏪 *${config.name}*\nPilih menu di bawah:`, { reply_markup: buildMainKeyboard(ctx.from.id) });
});

// ==================== /manage DI GRUP ====================
bot.command('list', async (ctx) => {
    if (isGroup(ctx)) return replyListProduk(ctx, ctx.message.message_id);
    // Di private, arahkan ke menu utama
    await ctx.reply(`🏪 *${config.name}*\nPilih menu di bawah:${WATERMARK}`, {
        parse_mode: 'Markdown',
        reply_markup: buildMainKeyboard(ctx.from.id)
    });
});

bot.command('manage', async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply('Perintah ini hanya untuk digunakan di dalam grup.');
    let isGA = false;
    try {
        const admins = await bot.telegram.getChatAdministrators(ctx.chat.id);
        isGA = !!admins.find(a => a.user.id === ctx.from.id);
    } catch(e) {}
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup yang bisa menggunakan ini!');
    await ctx.reply(
        `⚙️ *KELOLA GRUP*\n📌 ${ctx.chat.title}${GRUP_WATERMARK}`,
        { parse_mode: 'Markdown', reply_markup: buildGroupManageKeyboard(ctx.chat.id) }
    );
});

// ==================== BELANJA ====================
bot.action('belanja', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const categories = db.filter(DB.categories, c => c.aktif);
    if (!categories.length) {
        return safeEditMessage(ctx, '📂 Belum ada kategori tersedia.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_to_menu' }]] }
        });
    }
    const buttons = categories.map(cat => [{ text: `${cat.icon || '📦'} ${cat.nama}`, callback_data: `kategori_${cat.id}` }]);
    buttons.push([{ text: '🔙 Kembali', callback_data: 'back_to_menu' }]);
    await safeEditMessage(ctx, '📂 *PILIH KATEGORI:*', { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^kategori_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const kId = ctx.match[1];
    const products = db.filter(DB.products, p => p.kategori === kId && p.aktif !== false);
    if (!products.length) return safeAnswerCbQuery(ctx, 'Belum ada produk di kategori ini.', true);
    const buttons = products.map(p => [{ text: `${p.icon || '📦'} ${p.nama}`, callback_data: `produk_${p.id}` }]);
    buttons.push([{ text: '🔙 Kategori', callback_data: 'belanja' }]);
    await safeEditMessage(ctx, '📦 *PILIH PRODUK:*', { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^produk_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const pid    = ctx.match[1];
    const produk = db.find(DB.products, p => p.id === pid);
    if (!produk) return ctx.reply('❌ Produk tidak ditemukan!');
    const plans  = db.filter(DB.plans, p => p.produk_id === pid && p.aktif !== false);
    if (!plans.length) return ctx.reply('❌ Belum ada paket untuk produk ini.');
    let msg = `${produk.icon||'📦'} *${produk.nama}*\n📝 ${produk.deskripsi || 'Produk digital'}\n\n📋 *Pilihan Paket:*\n`;
    const buttons = [];
    for (const plan of plans) {
        const dur  = plan.durasi >= 30 ? `${Math.floor(plan.durasi / 30)} Bulan` : `${plan.durasi} Hari`;
        const stok = hitungStokAkun(plan.id);
        const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
        msg += `• ${plan.nama} (${dur}) — *${formatRp(plan.harga)}* ${icon}\n`;
        if (stok > 0) buttons.push([{ text: `🛒 ${plan.nama} — ${formatRp(plan.harga)}`, callback_data: `tambah_keranjang_${plan.id}` }]);
    }
    buttons.push([
        { text: '💳 Cara Bayar', callback_data: 'menu_cara_bayar' },
        { text: '🔙 Kembali',    callback_data: `kategori_${produk.kategori}` }
    ]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^tambah_keranjang_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const plan   = db.find(DB.plans, p => p.id === planId);
    if (!plan) return ctx.reply('❌ Plan tidak ditemukan!');
    if (!ctx.session.cart) ctx.session.cart = { items: [], total: 0 };
    ctx.session.cart.items.push({ planId, qty: 1, harga: plan.harga, planNama: plan.nama, produkId: plan.produk_id });
    ctx.session.cart.total += plan.harga;
    await ctx.answerCbQuery('✅ Ditambahkan ke keranjang!');
    await ctx.reply(`✅ *${plan.nama}* ditambahkan!\n💰 Total keranjang: *${formatRp(ctx.session.cart.total)}*`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
            [{ text: '🛒 Lihat Keranjang', callback_data: 'lihat_keranjang' }],
            [{ text: '🛍️ Lanjut Belanja',  callback_data: 'belanja' }]
        ]}
    });
});

// ==================== KERANJANG ====================
bot.action('lihat_keranjang', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!ctx.session.cart?.items?.length) {
        return safeEditMessage(ctx, '🛒 *KERANJANG KOSONG*\nBelum ada item.', {
            reply_markup: { inline_keyboard: [
                [{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }],
                [{ text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }]
            ]}
        });
    }
    let msg = '🛒 *KERANJANG ANDA*\n\n';
    ctx.session.cart.items.forEach((item, i) => { msg += `${i + 1}. *${item.planNama}* — ${formatRp(item.harga)}\n`; });
    msg += `\n💰 *TOTAL: ${formatRp(ctx.session.cart.total)}*`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '✅ Checkout Sekarang',  callback_data: 'checkout' }],
        [{ text: '🛍️ Lanjut Belanja',    callback_data: 'belanja' }, { text: '🗑️ Kosongkan', callback_data: 'kosongkan_keranjang' }],
        [{ text: '🔙 Menu Utama',         callback_data: 'back_to_menu' }],
    ]}});
});

bot.action('kosongkan_keranjang', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    ctx.session.cart = { items: [], total: 0 };
    await safeEditMessage(ctx, '🗑️ Keranjang berhasil dikosongkan.', {
        reply_markup: { inline_keyboard: [
            [{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }],
            [{ text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }]
        ]}
    });
});

// ==================== CHECKOUT ====================
bot.action('checkout', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!ctx.session.cart?.items?.length) return ctx.answerCbQuery('Keranjang kosong!', { show_alert: true });
    const invoiceId = genInvoiceId(ctx.from.id);
    const order = {
        id: invoiceId, userId: ctx.from.id, customerName: ctx.from.first_name,
        username: ctx.from.username, items: ctx.session.cart.items,
        total: ctx.session.cart.total, status: 'pending', createdAt: new Date().toISOString()
    };
    db.push(DB.orders, order);
    ctx.session.cart = { items: [], total: 0 };
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) {
        return safeEditMessage(ctx, '❌ Belum ada metode pembayaran tersedia.\nHubungi admin.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'back_to_menu' }]] }
        });
    }
    const buttons = qrisList.map(q => [{ text: `💳 ${q.nama}`, callback_data: `pay_${invoiceId}_${q.kode}` }]);
    buttons.push([{ text: '❌ Batal Order', callback_data: 'back_to_menu' }]);
    await safeEditMessage(ctx,
        `🧾 *INVOICE BARU*\n\n🆔 ID: \`${invoiceId}\`\n💰 Total: *${formatRp(order.total)}*\n\n💳 Pilih metode pembayaran:`,
        { reply_markup: { inline_keyboard: buttons } }
    );
});

bot.action(/^pay_(.+?)_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const qrisKode  = ctx.match[2];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    const qris = db.find(DB.qris, q => q.kode === qrisKode);
    if (!qris) return ctx.reply('❌ Metode tidak ditemukan!');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.metodePembayaran = qrisKode; o.status = 'waiting_payment'; });
    let msg = `✅ *ORDER BERHASIL DIBUAT!*\n\n🆔 Invoice: \`${invoiceId}\`\n💰 Total: *${formatRp(order.total)}*\n💳 Metode: *${qris.nama}*\n`;
    if (qris.nomor)     msg += `📋 Nomor: \`${qris.nomor}\`\n`;
    if (qris.atas_nama) msg += `👤 Atas Nama: *${qris.atas_nama}*\n`;
    msg += `\n✅ Orderan diterima! Kirim bukti beserta no invoicenya.`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📋 Cek Status Order', callback_data: `detail_order_${invoiceId}` }],
        [{ text: '🛍️ Belanja Lagi',    callback_data: 'belanja' }],
        [{ text: '🔙 Menu Utama',       callback_data: 'back_to_menu' }],
    ]}});
    if (qris.qrisImage) {
        try { await ctx.replyWithPhoto(qris.qrisImage, { caption: `💳 QR Code — ${qris.nama}\nInvoice: \`${invoiceId}\``, parse_mode: 'Markdown' }); } catch(e) {}
    }
    await sendToAdmins(
        `🛎️ *ORDER BARU!*\n🆔 ${invoiceId}\n👤 ${order.customerName} (@${order.username || '-'})\n💰 ${formatRp(order.total)}\n💳 ${qris.nama}`,
        { reply_markup: { inline_keyboard: [
            [{ text: '✅ Konfirmasi', callback_data: `konfirmasi_order_${invoiceId}` }, { text: '❌ Batalkan', callback_data: `batalkan_order_${invoiceId}` }]
        ]}}
    );
});

// ==================== CARA BAYAR ====================
bot.action('menu_cara_bayar', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) {
        return safeEditMessage(ctx, '❌ Belum ada metode pembayaran.\nHubungi admin.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'back_to_menu' }]] }
        });
    }
    let msg = `💳 *METODE PEMBAYARAN*\n${'─'.repeat(25)}\n\n`;
    const buttons = [];
    for (const q of qrisList) {
        msg += `💳 *${q.nama}*\n`;
        if (q.nomor)     msg += `📋 No: \`${q.nomor}\`\n`;
        if (q.atas_nama) msg += `👤 A/N: ${q.atas_nama}\n`;
        msg += '\n';
        if (q.qrisImage) buttons.push([{ text: `🖼️ QR ${q.nama}`, callback_data: `show_qr_${q.kode}` }]);
    }
    buttons.push([{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }, { text: '🔙 Menu Utama', callback_data: 'back_to_menu' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^show_qr_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const qris = db.find(DB.qris, q => q.kode === ctx.match[1]);
    if (!qris || !qris.qrisImage) return ctx.reply('❌ QR Code tidak tersedia.');
    await ctx.replyWithPhoto(qris.qrisImage, {
        caption: `💳 *QR Code — ${qris.nama}*${qris.nomor ? `\n📋 No: \`${qris.nomor}\`` : ''}`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }]] }
    });
});

// ==================== HISTORI ====================
bot.action('history_customer', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const orders = db.filter(DB.orders, o => o.userId === ctx.from.id);
    if (!orders.length) {
        return safeEditMessage(ctx, '📋 *HISTORI ORDER*\n\nBelum ada order.', {
            reply_markup: { inline_keyboard: [
                [{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }],
                [{ text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }]
            ]}
        });
    }
    let msg = '📋 *HISTORI ORDER (10 Terakhir)*\n\n';
    const buttons = [];
    orders.slice(-10).reverse().forEach(o => {
        const s = { pending:'⏳', waiting_payment:'💳', paid:'✅', cancelled:'❌', completed:'🎉' }[o.status] || '❓';
        msg += `${s} \`${o.id}\`\n💰 ${formatRp(o.total)} • ${formatDateShort(o.createdAt)}\n\n`;
        buttons.push([{ text: `${s} ${o.id} — ${formatRp(o.total)}`, callback_data: `detail_order_${o.id}` }]);
    });
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'back_to_menu' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^detail_order_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const order = db.find(DB.orders, o => o.id === ctx.match[1]);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.userId !== ctx.from.id && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const statusMap = { pending:'⏳ Menunggu', waiting_payment:'💳 Menunggu Pembayaran', paid:'✅ Dibayar', cancelled:'❌ Dibatalkan', completed:'🎉 Selesai' };
    let msg = `🧾 *DETAIL ORDER*\n\n🆔 Invoice: \`${order.id}\`\n📊 Status: *${statusMap[order.status] || order.status}*\n💰 Total: *${formatRp(order.total)}*\n`;
    if (order.metodePembayaran) msg += `💳 Metode: ${order.metodePembayaran}\n`;
    msg += `📅 Dibuat: ${formatDate(order.createdAt)}\n`;
    if (order.confirmedAt) msg += `✅ Dikonfirmasi: ${formatDate(order.confirmedAt)}\n`;
    if (order.items?.length) {
        msg += `\n🛒 *Item:*\n`;
        order.items.forEach(item => { msg += `• ${item.planNama} — ${formatRp(item.harga)}\n`; });
    }
    const buttons = [];
    if (isAdminOrOwner(ctx.from.id) && order.status === 'waiting_payment') {
        buttons.push([
            { text: '✅ Konfirmasi',    callback_data: `konfirmasi_order_${order.id}` },
            { text: '❌ Batalkan',      callback_data: `batalkan_order_${order.id}` }
        ]);
    }
    if (isAdminOrOwner(ctx.from.id)) {
        buttons.push([{ text: '📤 Kirim Akun Manual', callback_data: `kirim_manual_${order.id}` }]);
        buttons.push([{ text: '🔙 Semua Order', callback_data: 'admin_orders' }]);
    } else {
        buttons.push([{ text: '🔙 Riwayat', callback_data: 'history_customer' }]);
    }
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

// ==================== PROFIL ====================
bot.action('profil_customer', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const cust = db.find(DB.customers, c => c.id === ctx.from.id);
    if (!cust) return safeAnswerCbQuery(ctx, 'Data tidak ditemukan.', true);
    const msg = `👤 *PROFIL ANDA*\n\n🔖 Nama: *${cust.first_name || '-'} ${cust.last_name || ''}*\n📱 Username: @${cust.username || '-'}\n🆔 ID: \`${cust.id}\`\n📅 Bergabung: ${formatDateShort(cust.joinDate)}\n💰 Total Belanja: *${formatRp(cust.totalBelanja)}*\n📦 Total Order: ${cust.totalOrder}`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📋 Riwayat Order', callback_data: 'history_customer' }],
        [{ text: '🔙 Menu Utama',    callback_data: 'back_to_menu' }]
    ]}});
});

// ==================== PROMO ====================
bot.action('menu_promo', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const announcements = db.filter(DB.announcements, a => a.aktif);
    let msg = '📢 *PROMO & PENGUMUMAN*\n\n';
    if (!announcements.length) msg += 'Belum ada promo saat ini.';
    else announcements.slice(0, 5).forEach(a => { msg += `📌 *${a.judul}*\n${a.isi}\n\n`; });
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '🛍️ Belanja Sekarang', callback_data: 'belanja' }],
        [{ text: '🔙 Menu Utama',        callback_data: 'back_to_menu' }]
    ]}});
});

// ==================== BANTUAN ====================
bot.action('help_menu', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const msg = `❓ *BANTUAN & PANDUAN*\n\n📌 *Cara Belanja:*\n1. Pilih 🛍️ Belanja\n2. Pilih kategori & produk\n3. Tambah ke keranjang\n4. Checkout & pilih metode bayar\n5. Transfer & kirim bukti ke admin\n6. Akun dikirim otomatis setelah konfirmasi\n\n📌 *Command berguna:*\n/menu — Buka menu utama\n/cekorder [invoice] — Cek status order\n/pay — Cara pembayaran\n\n📌 *Di grup:*\n/manage — Kelola grup (admin)\n/rules — Lihat peraturan`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '💳 Cara Bayar',     callback_data: 'menu_cara_bayar' }],
        [{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }],
        [{ text: '🔙 Menu Utama',     callback_data: 'back_to_menu' }]
    ]}});
});

// ==================== ADMIN PANEL ====================
bot.action('admin_panel', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const totalOrders    = db.read(DB.orders).length;
    const totalCustomers = db.read(DB.customers).length;
    const pendingOrders  = db.filter(DB.orders, o => o.status === 'waiting_payment').length;
    const totalStok      = db.read(DB.akun_stok).filter(a => !a.used).length;
    const msg = `⚙️ *ADMIN PANEL*\n\n📊 Total Order: ${totalOrders}\n⏳ Menunggu Konfirmasi: *${pendingOrders}*\n👥 Total Pelanggan: ${totalCustomers}\n📦 Total Stok Akun: ${totalStok}\n🕐 ${formatDate(new Date())}`;
    await safeEditMessage(ctx, msg, { reply_markup: buildAdminKeyboard() });
});

bot.action('admin_orders_pending', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const orders = db.filter(DB.orders, o => o.status === 'waiting_payment');
    let msg = `⏳ *ORDER MENUNGGU KONFIRMASI*\n\nTotal: ${orders.length}\n\n`;
    if (!orders.length) msg += '_Tidak ada order pending._';
    else orders.slice(-15).reverse().forEach(o => {
        msg += `💳 \`${o.id}\`\n👤 ${o.customerName} (@${o.username || '-'})\n💰 *${formatRp(o.total)}*\n📅 ${formatDateShort(o.createdAt)}\n\n`;
    });
    const buttons = orders.slice(-15).reverse().map(o => ([
        { text: `✅ ${o.id.slice(-8)}`, callback_data: `konfirmasi_order_${o.id}` },
        { text: `❌ Batal`,             callback_data: `batalkan_order_${o.id}` }
    ]));
    buttons.push([{ text: '🔄 Refresh', callback_data: 'admin_orders_pending' }, { text: '🔙 Admin', callback_data: 'admin_panel' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action('admin_stats', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const orders = db.read(DB.orders);
    const totalRevenue = orders.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0);
    const clones = db.read(DB.clones);
    const cloneAktif = [...activeCloneProcesses.keys()].length;
    const stokHabis = db.read(DB.plans).filter(p => hitungStokAkun(p.id) === 0 && p.aktif !== false).length;
    const msg = `📊 *STATISTIK BOT*\n\n📦 Produk: ${db.read(DB.products).length}\n👥 Pelanggan: ${db.read(DB.customers).length}\n📋 Total Order: ${orders.length}\n✅ Selesai: ${orders.filter(o => o.status === 'completed').length}\n⏳ Pending: ${orders.filter(o => ['pending','waiting_payment'].includes(o.status)).length}\n❌ Batal: ${orders.filter(o => o.status === 'cancelled').length}\n💰 Total Revenue: *${formatRp(totalRevenue)}*\n🤖 Clone Aktif: ${cloneAktif}/${clones.length}\n⚠️ Stok Habis: ${stokHabis} plan`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Refresh',  callback_data: 'admin_stats' }],
        [{ text: '🔙 Admin',    callback_data: 'admin_panel' }]
    ]}});
});

bot.action('admin_orders', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const orders = db.read(DB.orders).slice(-10).reverse();
    let msg = '📋 *10 ORDER TERBARU*\n\n';
    if (!orders.length) msg += 'Belum ada order.';
    else orders.forEach(o => {
        const s = { pending:'⏳', waiting_payment:'💳', paid:'✅', cancelled:'❌', completed:'🎉' }[o.status] || '❓';
        msg += `${s} \`${o.id}\`\n👤 ${o.customerName} • *${formatRp(o.total)}*\n📅 ${formatDateShort(o.createdAt)}\n\n`;
    });
    const buttons = orders.map(o => [{ text: `🔍 Detail ${o.id.slice(-8)} — ${formatRp(o.total)}`, callback_data: `detail_order_${o.id}` }]);
    buttons.push([
        { text: '⏳ Lihat Pending', callback_data: 'admin_orders_pending' },
        { text: '🔙 Admin',         callback_data: 'admin_panel' }
    ]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action(/^konfirmasi_order_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.status === 'completed') return ctx.reply('⚠️ Order sudah dikonfirmasi!');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'completed'; o.confirmedAt = new Date().toISOString(); o.confirmedBy = ctx.from.id; });
    db.update(DB.customers, c => c.id === order.userId, c => { c.totalBelanja += order.total; c.totalOrder += 1; });
    const ok = await autoDeliveryAkun(ctx, order);
    if (!ok) {
        try { await bot.telegram.sendMessage(order.userId, `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n🆔 Invoice: \`${invoiceId}\`\n💰 Total: ${formatRp(order.total)}\n\nAkun akan segera dikirim admin.${WATERMARK}`, { parse_mode: 'Markdown' }); } catch(e) {}
    }
    await ctx.reply(
        `✅ Order \`${invoiceId}\` dikonfirmasi.${ok ? '\n🤖 Akun terkirim otomatis.' : '\n⚠️ Stok habis — kirim manual!'}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '📤 Kirim Akun Manual', callback_data: `kirim_manual_${invoiceId}` }],
            [{ text: '⏳ Order Pending',       callback_data: 'admin_orders_pending' }]
        ]}}
    );
});

bot.action(/^batalkan_order_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.status === 'cancelled') return ctx.reply('⚠️ Order sudah dibatalkan!');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = 'Dibatalkan admin'; });
    try { await bot.telegram.sendMessage(order.userId, `❌ *ORDER DIBATALKAN*\n\n🆔 \`${invoiceId}\`\nAlasan: Dibatalkan admin\n\nHubungi admin jika ada pertanyaan.`, { parse_mode: 'Markdown' }); } catch(e) {}
    await ctx.reply(`✅ Order \`${invoiceId}\` dibatalkan.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⏳ Order Pending', callback_data: 'admin_orders_pending' }]] }});
});

bot.action(/^kirim_manual_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');

    const allManual = (order.items || []).every(item => isManualProduct(item.planId));
    ctx.session.action = `kirim_manual_${invoiceId}`;

    if (allManual) {
        // Produk manual: minta pesan singkat, tidak perlu format akun
        await ctx.reply(
            `💬 *KIRIM PESAN KE CUSTOMER*\n\n🆔 Order: \`${invoiceId}\`\n👤 ${order.customerName}\n📦 ${(order.items||[]).map(i=>i.planNama).join(', ')}\n\n_Ketik pesan yang akan dikirim ke customer (bebas format):_`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `detail_order_${invoiceId}` }]] }}
        );
    } else {
        // Produk dari stok: minta format akun
        await ctx.reply(
            `📤 *KIRIM AKUN MANUAL*\n\n🆔 Order: \`${invoiceId}\`\n👤 ${order.customerName}\n\nKirim akun/data yang akan diteruskan ke pelanggan:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `detail_order_${invoiceId}` }]] }}
        );
    }
});

bot.action('admin_customers', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const customers = db.read(DB.customers);
    let msg = `👥 *PELANGGAN*\n\nTotal: ${customers.length}\n\n`;
    customers.slice(-10).reverse().forEach(c => {
        msg += `• 👤 *${c.first_name || '-'}* (@${c.username || '-'})\n  ID: \`${c.id}\` • Order: ${c.totalOrder} • Belanja: ${formatRp(c.totalBelanja)}\n\n`;
    });
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📊 Statistik',  callback_data: 'admin_stats' }],
        [{ text: '🔙 Admin',      callback_data: 'admin_panel' }]
    ]}});
});

bot.action('admin_produk', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const products = db.read(DB.products);
    const shown = products.slice(-15).reverse();
    let msg = `📦 *KELOLA PRODUK*\n\nTotal: ${products.length}\n\n`;
    if (!shown.length) msg += `Belum ada produk.\n`;
    else shown.forEach(p => { msg += `• ${p.aktif !== false ? '✅' : '❌'} *${p.nama || 'Tanpa Nama'}* (\`${p.id || '-'}\`)\n`; });
    if (products.length > 15) msg += `_...dan ${products.length - 15} produk lainnya_\n`;
    msg += `\n📥 *Tambah produk:*\n/input\n\n🗑 *Hapus produk:*\n/hapus_produk [id]`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '🗂️ Kategori',  callback_data: 'admin_kategori' }, { text: '📋 Paket', callback_data: 'admin_plans' }],
        [{ text: '🔙 Admin',     callback_data: 'admin_panel' }]
    ]}});
});

bot.action('admin_kategori', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const cats = db.read(DB.categories);
    let msg = `🗂️ *KELOLA KATEGORI*\n\nTotal: ${cats.length}\n\n`;
    cats.forEach(c => { msg += `• ${c.aktif ? '✅' : '❌'} ${c.icon || '📦'} *${escapeMd(c.nama)}* (\`${escapeMd(c.id)}\`)\n`; });
    msg += `\n📥 Kategori dibuat otomatis via /input\n/hapus_kategori [id] — hapus kategori`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📦 Produk',   callback_data: 'admin_produk' }],
        [{ text: '🔙 Admin',    callback_data: 'admin_panel' }]
    ]}});
});

bot.action('admin_plans', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const allPlans = db.read(DB.plans);
    const plans = allPlans.slice(-15).reverse();
    let msg = `📋 *KELOLA PAKET*\n\nTotal: ${allPlans.length}\n\n`;
    if (!plans.length) msg += `Belum ada paket.\n`;
    else plans.forEach(p => {
        const stok = hitungStokAkun(p.id);
        const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
        msg += `• ${icon} *${p.nama || '-'}* — ${formatRp(p.harga)} (stok: ${stok}) [\`${p.id || '-'}\`]\n`;
    });
    msg += `\n📥 Paket dibuat otomatis via /input\n/hapus_produk [id] — hapus produk & paketnya`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📥 Input Akun',  callback_data: 'admin_input_akun' }, { text: '📦 Stok', callback_data: 'admin_lihat_stok_akun' }],
        [{ text: '🔙 Admin',       callback_data: 'admin_panel' }]
    ]}});
});

bot.action('admin_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const qrisList = db.read(DB.qris);
    let msg = `💳 *KELOLA PEMBAYARAN*\n\nTotal: ${qrisList.length}\n\n`;
    qrisList.forEach(q => { msg += `• ${q.aktif ? '✅' : '❌'} *${q.nama}* (\`${q.kode}\`)\n  No: ${q.nomor || '-'} | QR: ${q.qrisImage ? '✅' : '❌'}\n\n`; });
    msg += `*Perintah:*\n/tambah_qris [kode] [nama] [nomor]\n/hapus_qris [kode]\nReply gambar + /upload_qris [kode]`;
    const buttons = qrisList.filter(q => q.qrisImage).map(q => [{ text: `🖼️ QR ${q.nama}`, callback_data: `show_qr_${q.kode}` }]);
    buttons.push([{ text: '🔙 Admin', callback_data: 'admin_panel' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: buttons } });
});

bot.action('admin_announcement', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Akses ditolak!', true);
    await safeAnswerCbQuery(ctx);
    const anns = db.read(DB.announcements);
    let msg = `📢 *KELOLA PENGUMUMAN*\n\nTotal: ${anns.length}\n\n`;
    anns.slice(-5).forEach(a => { msg += `• ${a.aktif ? '✅' : '❌'} *${a.judul}* (\`${a.id}\`)\n${a.isi.slice(0, 60)}${a.isi.length > 60 ? '...' : ''}\n\n`; });
    msg += `*Perintah:*\n/buat_pengumuman [judul] | [isi]\n/hapus_pengumuman [id]`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📢 Lihat di Promo', callback_data: 'menu_promo' }],
        [{ text: '🔙 Admin',           callback_data: 'admin_panel' }]
    ]}});
});

// ==================== STOK AKUN ====================
bot.action('admin_input_akun', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const plans    = db.filter(DB.plans, p => p.aktif !== false);
    const products = db.read(DB.products);
    if (!plans.length) return safeEditMessage(ctx, '❌ Belum ada plan.\nBuat produk dulu dengan /input', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'admin_panel' }]] }
    });
    let msg = `📥 *INPUT AKUN KE STOK*\n\nPilih plan untuk diisi:\n\n`;
    const btns = [];
    for (const pl of plans) {
        const prod = products.find(p => p.id === pl.produk_id);
        const stok = hitungStokAkun(pl.id);
        const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
        msg += `${icon} *${prod?.nama || '?'}* — ${pl.nama}: *${stok} akun*\n`;
        btns.push([{ text: `📥 ${prod?.nama || '?'} — ${pl.nama} (${stok})`, callback_data: `input_akun_plan_${pl.id}` }]);
    }
    btns.push([{ text: '📦 Lihat Stok', callback_data: 'admin_lihat_stok_akun' }, { text: '🔙 Admin', callback_data: 'admin_panel' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: btns } });
});

bot.action(/^input_akun_plan_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const plan   = db.find(DB.plans, p => p.id === planId);
    const prod   = plan ? db.find(DB.products, p => p.id === plan.produk_id) : null;
    ctx.session.action = `input_akun_bulk_${planId}`;
    await ctx.reply(
        `📥 *INPUT AKUN — ${prod?.nama || '?'} ${plan?.nama || planId}*\n\n` +
        `Stok saat ini: *${hitungStokAkun(planId)} akun*\n\n` +
        `Kirim daftar akun (satu baris = satu akun):\n` +
        `\`\`\`\nuser1@gmail.com|pass123\nuser2@gmail.com|pass456\n\`\`\`\n\n_Duplikat otomatis dilewati._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'admin_input_akun' }]] } }
    );
});

bot.action('admin_lihat_stok_akun', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const plans    = db.filter(DB.plans, p => p.aktif !== false);
    const products = db.read(DB.products);
    let msg = `📦 *STOK AKUN PER PLAN*\n\n`;
    const btns = [];
    let total = 0;
    for (const pl of plans) {
        const prod = products.find(p => p.id === pl.produk_id);
        const stok = hitungStokAkun(pl.id);
        total += stok;
        const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
        msg += `${icon} *${prod?.nama || '?'}* — ${pl.nama}: *${stok}*\n`;
        btns.push([
            { text: `👁 ${pl.nama} (${stok})`, callback_data: `lihat_akun_plan_${pl.id}` },
            { text: `📥 Isi Stok`,              callback_data: `input_akun_plan_${pl.id}` },
        ]);
    }
    msg += `\n📊 Total tersedia: *${total} akun*`;
    btns.push([{ text: '🔄 Refresh', callback_data: 'admin_lihat_stok_akun' }, { text: '🔙 Admin', callback_data: 'admin_panel' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: btns } });
});

bot.action(/^lihat_akun_plan_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const plan   = db.find(DB.plans, p => p.id === planId);
    const prod   = plan ? db.find(DB.products, p => p.id === plan.produk_id) : null;
    const semua  = db.read(DB.akun_stok).filter(a => a.planId === planId);
    const avail  = semua.filter(a => !a.used);
    const used   = semua.filter(a => a.used);
    let msg = `👁 *STOK — ${prod?.nama || '?'} ${plan?.nama || planId}*\n\n✅ Tersedia: *${avail.length}*\n📤 Terpakai: *${used.length}*\n\n`;
    if (avail.length) {
        msg += `*Preview 5 pertama:*\n\`\`\`\n`;
        avail.slice(0, 5).forEach(a => { msg += `${a.akun}\n`; });
        msg += `\`\`\``;
        if (avail.length > 5) msg += `\n_...dan ${avail.length - 5} lainnya_`;
    } else msg += `_Stok kosong!_`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📥 Tambah Akun',  callback_data: `input_akun_plan_${planId}` }, { text: '🗑 Hapus Stok', callback_data: `hapus_akun_${planId}` }],
        [{ text: '🔙 Stok',          callback_data: 'admin_lihat_stok_akun' }],
    ]}});
});

bot.action(/^hapus_akun_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const plan   = db.find(DB.plans, p => p.id === planId);
    await safeEditMessage(ctx, `⚠️ *Hapus semua stok akun ${plan?.nama}?*\n_(Akun yang sudah terpakai tidak dihapus)_`, {
        reply_markup: { inline_keyboard: [
            [{ text: '✅ Ya, Hapus', callback_data: `konfirm_hapus_akun_${planId}` }, { text: '❌ Batal', callback_data: `lihat_akun_plan_${planId}` }],
        ]}
    });
});

bot.action(/^konfirm_hapus_akun_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const stok   = db.read(DB.akun_stok);
    const before = stok.filter(a => a.planId === planId && !a.used).length;
    db.write(DB.akun_stok, stok.filter(a => !(a.planId === planId && !a.used)));
    await safeEditMessage(ctx, `✅ *${before} akun* dihapus dari stok.`, {
        reply_markup: { inline_keyboard: [
            [{ text: '📥 Isi Stok Baru', callback_data: `input_akun_plan_${planId}` }],
            [{ text: '🔙 Stok',           callback_data: 'admin_lihat_stok_akun' }]
        ]}
    });
});

// ==================== OWNER PANEL ====================
bot.action('owner_panel', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const clones     = db.read(DB.clones);
    const cloneAktif = [...activeCloneProcesses.keys()].length;
    const msg = `👑 *OWNER PANEL*\n\n🤖 Bot: *${config.name}* v${BOT_VERSION}\n👮 Admin: ${db.read(DB.admins).length}\n🤖 Clone Bot: ${clones.length} (${cloneAktif} aktif)\n🔧 Maintenance: ${config.maintenance ? '🔴 ON' : '🟢 OFF'}\n🕐 ${formatDate(new Date())}`;
    const kb = buildOwnerKeyboard();
    kb.inline_keyboard.push([{ text: '📖 Panduan Lengkap', callback_data: 'owner_guide_full' }]);
    await safeEditMessage(ctx, msg, { reply_markup: kb });
});

bot.action('owner_admins', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const admins = db.read(DB.admins);
    let msg = `👮 *KELOLA ADMIN*\n\nTotal: ${admins.length}\n\n`;
    admins.forEach(a => { msg += `• ${a.aktif !== false ? '✅' : '❌'} *${a.nama || '-'}* (\`${a.id}\`)\n`; });
    msg += `\n*Perintah:*\n/tambah_admin [user_id] [nama]\n/hapus_admin [user_id]`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Owner', callback_data: 'owner_panel' }]] } });
});

bot.action('owner_blocked', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const blocked = db.read(DB.blocked_users);
    let msg = `🚫 *BLOCKED USERS*\n\nTotal: ${blocked.length}\n\n`;
    blocked.forEach(b => { msg += `• ID: \`${b.userId}\` — ${b.alasan || '-'}\n`; });
    msg += `\n*Perintah:*\n/blokir [user_id] [alasan]\n/unblokir [user_id]`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Owner', callback_data: 'owner_panel' }]] } });
});

bot.action('owner_maintenance', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    config.maintenance = !config.maintenance;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    await ctx.answerCbQuery(`🔧 Maintenance ${config.maintenance ? 'AKTIF' : 'NONAKTIF'}!`);
    await safeEditMessage(ctx, `👑 *OWNER PANEL*\n\n🔧 Maintenance: ${config.maintenance ? '🔴 ON' : '🟢 OFF'}`, { reply_markup: buildOwnerKeyboard() });
});

bot.action('owner_settings', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const msg = `⚙️ *PENGATURAN BOT*\n\n🏪 Nama: ${config.name}\n🌐 Timezone: ${config.timezone}\n🔑 Version: ${BOT_VERSION}\n\n*Perintah:*\n/set_nama [nama]`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Owner', callback_data: 'owner_panel' }]] } });
});

bot.action('owner_broadcast', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    ctx.session.action = 'broadcast';
    await safeEditMessage(ctx, `📢 *BROADCAST*\n\nTotal pelanggan: ${db.read(DB.customers).length}\n\nKirim pesan yang ingin dibroadcast:`, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'owner_panel' }]] }
    });
});

bot.action('owner_report', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const orders    = db.read(DB.orders);
    const customers = db.read(DB.customers);
    const today     = new Date().toDateString();
    const todayRevenue  = orders.filter(o => new Date(o.createdAt).toDateString() === today && o.status === 'completed').reduce((s, o) => s + o.total, 0);
    const totalRevenue  = orders.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0);
    const todayOrders   = orders.filter(o => new Date(o.createdAt).toDateString() === today);
    const msg = `📊 *LAPORAN OWNER*\n\n📅 *Hari Ini (${formatDateShort(new Date())})*\n• Order Baru: ${todayOrders.length}\n• Selesai: ${todayOrders.filter(o => o.status === 'completed').length}\n• Revenue: ${formatRp(todayRevenue)}\n\n📈 *Keseluruhan*\n• Pelanggan: ${customers.length}\n• Total Order: ${orders.length}\n• Selesai: ${orders.filter(o => o.status === 'completed').length}\n• Dibatalkan: ${orders.filter(o => o.status === 'cancelled').length}\n• Total Revenue: *${formatRp(totalRevenue)}*`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Refresh',   callback_data: 'owner_report' }],
        [{ text: '📊 Statistik', callback_data: 'admin_stats' }],
        [{ text: '🔙 Owner',     callback_data: 'owner_panel' }]
    ]}});
});

// ==================== CLONE BOT SYSTEM ====================
const activeCloneProcesses = new Map();

function generateCloneScript(botToken, botName, ownerId, dataRoot) {
    const escaped = dataRoot.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Path ke node_modules parent (bot utama) agar clone bisa pakai modul yang sama
    const parentDir = __rootDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'use strict';
// Resolve modules dari parent directory jika tidak ada di lokal
const Module = require('module');
const path = require('path');
const _origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, parent, isMain, options) {
    try { return _origResolve(request, parent, isMain, options); }
    catch(e) {
        try {
            const parentMod = path.join('${parentDir}', 'node_modules', request);
            return _origResolve(parentMod, parent, isMain, options);
        } catch(e2) { throw e; }
    }
};
// Tambahkan parent node_modules ke path pencarian
if (!module.paths.includes(path.join('${parentDir}', 'node_modules'))) {
    module.paths.unshift(path.join('${parentDir}', 'node_modules'));
}

const { Telegraf, session } = require('telegraf');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const BOT_TOKEN = '${botToken}';
const BOT_NAME  = '${botName}';
const OWNER_ID  = ${ownerId};
const DATA_ROOT = path.join('${escaped}', 'clones', '${botName}');
const DB_PATH   = path.join(DATA_ROOT, 'db');
[DATA_ROOT, DB_PATH].forEach(d => fs.ensureDirSync(d));

const DB = {
    config:        path.join(DATA_ROOT, 'config.json'),
    qris:          path.join(DB_PATH, 'qris.json'),
    categories:    path.join(DB_PATH, 'categories.json'),
    products:      path.join(DB_PATH, 'products.json'),
    plans:         path.join(DB_PATH, 'plans.json'),
    customers:     path.join(DB_PATH, 'customers.json'),
    orders:        path.join(DB_PATH, 'orders.json'),
    admins:        path.join(DB_PATH, 'admins.json'),
    announcements: path.join(DB_PATH, 'announcements.json'),
    blocked_users: path.join(DB_PATH, 'blocked_users.json'),
    group_rules:   path.join(DB_PATH, 'group_rules.json'),
    group_warns:   path.join(DB_PATH, 'group_warns.json'),
    group_mutes:   path.join(DB_PATH, 'group_mutes.json'),
    group_welcome: path.join(DB_PATH, 'group_welcome.json'),
    akun_stok:     path.join(DB_PATH, 'akun_stok.json'),
};

Object.entries(DB).forEach(([k, f]) => {
    if (k === 'config') return;
    if (!fs.existsSync(f)) fs.writeJsonSync(f, [], { spaces: 2 });
});

const WATERMARK = '\\n\\n💧 *Powered by ${botName}*\\n🤖 _by @bujajg_';
let config = { name: '${botName}', ownerId: ${ownerId}, timezone: 'Asia/Jakarta', maintenance: false, aiEnabled: false, aiKey: '', aiModel: 'mistral-small-latest', aiPrompt: '', aiGroupEnabled: false, aiGroupFull: false };
if (fs.existsSync(DB.config)) { try { config = { ...config, ...fs.readJsonSync(DB.config) }; } catch(e) {} }
else { fs.writeJsonSync(DB.config, config, { spaces: 2 }); }

const db = {
    read:   (f) => { try { return fs.readJsonSync(f); } catch(e) { return []; } },
    write:  (f, d) => fs.writeJsonSync(f, d, { spaces: 2 }),
    find:   (f, fn) => db.read(f).find(fn),
    filter: (f, fn) => db.read(f).filter(fn),
    push:   (f, item) => { const a = db.read(f); a.push(item); db.write(f, a); return item; },
    update: (f, fn, upd) => { const a = db.read(f); const i = a.findIndex(fn); if (i !== -1) { upd(a[i]); db.write(f, a); return a[i]; } return null; },
    remove: (f, fn) => { const a = db.read(f); const r = a.filter(i => !fn(i)); db.write(f, r); return a.length - r.length; },
    upsert: (f, fn, d) => { const a = db.read(f); const i = a.findIndex(fn); if (i !== -1) { a[i] = { ...a[i], ...d }; db.write(f, a); return a[i]; } else { a.push({...d}); db.write(f, a); return d; } }
};

const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ defaultSession: () => ({ cart: { items: [], total: 0 }, action: null }) }));

function isOwner(id) { return config.ownerId === id || config.ownerId === String(id); }
function isAdmin(id) { return db.find(DB.admins, a => a.id === id && a.aktif !== false) !== undefined; }
function isAdminOrOwner(id) { return isOwner(id) || isAdmin(id); }
function isBlocked(id) { return db.find(DB.blocked_users, b => b.userId === id) !== undefined; }
function formatRp(n) { return 'Rp' + Number(n).toLocaleString('id-ID'); }
function formatDate(d) { return new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); }
function formatDateShort(d) { return new Date(d).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' }); }
function genInvoiceId(uid) { return 'INV-' + Date.now().toString(36).toUpperCase() + '-' + String(uid).slice(-4); }
function isPrivate(ctx) { return ctx.chat && ctx.chat.type === 'private'; }
function isGroup(ctx) { return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'); }
function hitungStok(planId) { try { return db.read(DB.akun_stok).filter(a => a.planId === planId && !a.used).length; } catch(e) { return 0; } }

async function safeAnswerCbQuery(ctx, text='', alert=false) { try { await ctx.answerCbQuery(text, { show_alert: alert }); } catch(e) {} }
async function safeEdit(ctx, text, extra={}) { try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }); } catch(e) { try { await ctx.reply(text, { parse_mode: 'Markdown', ...extra }); } catch(e2) {} } }

function ambilAkun(planId, orderId) {
    const stok = db.read(DB.akun_stok);
    const idx = stok.findIndex(a => a.planId === planId && !a.used);
    if (idx === -1) return null;
    stok[idx].used = true; stok[idx].orderId = orderId; stok[idx].usedAt = new Date().toISOString();
    db.write(DB.akun_stok, stok);
    return stok[idx].akun;
}

function registerCustomer(ctx) {
    if (!ctx.from) return;
    if (!db.find(DB.customers, c => c.id === ctx.from.id)) {
        db.push(DB.customers, { id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name, joinDate: new Date().toISOString(), totalBelanja: 0, totalOrder: 0 });
    }
}

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    if (isBlocked(ctx.from.id)) return ctx.reply('🚫 Anda diblokir.');
    if (config.maintenance && !isAdminOrOwner(ctx.from.id)) return ctx.reply('🔧 Bot maintenance.');
    if (isPrivate(ctx)) registerCustomer(ctx);
    await next();
});

function buildMainKb(userId) {
    const kb = { inline_keyboard: [
        [{ text: '🛍️ Belanja', callback_data: 'belanja' }, { text: '🛒 Keranjang', callback_data: 'keranjang' }],
        [{ text: '📋 Riwayat', callback_data: 'riwayat' }, { text: '💳 Cara Bayar', callback_data: 'cara_bayar' }],
        [{ text: '❓ Bantuan', callback_data: 'bantuan' }, { text: '👤 Profil', callback_data: 'profil' }],
    ]};
    if (isAdminOrOwner(userId)) kb.inline_keyboard.push([{ text: '⚙️ Admin', callback_data: 'admin' }]);
    return kb;
}

bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    ctx.reply('🏪 *Selamat datang di ' + config.name + '*\\n\\n👋 Halo ' + ctx.from.first_name + '!\\nPilih menu:' + WATERMARK, { parse_mode: 'Markdown', reply_markup: buildMainKb(ctx.from.id) });
});
bot.command('menu', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    ctx.reply('🏪 *MENU UTAMA*', { parse_mode: 'Markdown', reply_markup: buildMainKb(ctx.from.id) });
});
bot.action('back_menu', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEdit(ctx, '🏪 *' + config.name + '*\\nPilih menu:', { reply_markup: buildMainKb(ctx.from.id) });
});

bot.action('belanja', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const cats = db.filter(DB.categories, c => c.aktif);
    if (!cats.length) return await safeEdit(ctx, '❌ Belum ada produk.', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
    await safeEdit(ctx, '📂 *KATEGORI:*', { reply_markup: { inline_keyboard: [...cats.map(c => [{ text: (c.icon||'📦') + ' ' + c.nama, callback_data: 'kat_' + c.id }]), [{ text: '🔙 Menu', callback_data: 'back_menu' }]] } });
});
bot.action(/^kat_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const prods = db.filter(DB.products, p => p.kategori === ctx.match[1] && p.aktif !== false);
    if (!prods.length) return safeAnswerCbQuery(ctx, 'Belum ada produk.', true);
    await safeEdit(ctx, '📦 *PRODUK:*', { reply_markup: { inline_keyboard: [...prods.map(p => [{ text: p.nama, callback_data: 'prod_' + p.id }]), [{ text: '🔙', callback_data: 'belanja' }]] } });
});
bot.action(/^prod_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const prod = db.find(DB.products, p => p.id === ctx.match[1]);
    if (!prod) return;
    const plans = db.filter(DB.plans, p => p.produk_id === prod.id && p.aktif !== false);
    let msg = '📦 *' + prod.nama + '*\\n' + (prod.deskripsi || '') + '\\n\\n';
    const btns = plans.filter(pl => hitungStok(pl.id) > 0).map(pl => [{ text: pl.nama + ' — ' + formatRp(pl.harga), callback_data: 'cart_' + pl.id }]);
    btns.push([{ text: '🔙', callback_data: 'kat_' + prod.kategori }]);
    plans.forEach(pl => { msg += '• ' + pl.nama + ' — *' + formatRp(pl.harga) + '* ' + (hitungStok(pl.id) > 0 ? '✅' : '❌') + '\\n'; });
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: btns } });
});
bot.action(/^cart_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const plan = db.find(DB.plans, p => p.id === ctx.match[1]);
    if (!plan) return;
    if (!ctx.session.cart) ctx.session.cart = { items: [], total: 0 };
    ctx.session.cart.items.push({ planId: plan.id, harga: plan.harga, planNama: plan.nama, produkId: plan.produk_id });
    ctx.session.cart.total += plan.harga;
    ctx.answerCbQuery('✅ Ditambahkan!');
    ctx.reply('✅ *' + plan.nama + '* ditambahkan!\\n💰 Total: *' + formatRp(ctx.session.cart.total) + '*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛒 Keranjang', callback_data: 'keranjang' }],[{ text: '🛍️ Lanjut', callback_data: 'belanja' }]] } });
});

bot.action('keranjang', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!ctx.session.cart || !ctx.session.cart.items || !ctx.session.cart.items.length) return await safeEdit(ctx, '🛒 Keranjang kosong.', { reply_markup: { inline_keyboard: [[{ text: '🛍️ Belanja', callback_data: 'belanja' }]] } });
    let msg = '🛒 *KERANJANG*\\n\\n';
    ctx.session.cart.items.forEach(function(it, i) { msg += (i+1) + '. ' + it.planNama + ' — ' + formatRp(it.harga) + '\\n'; });
    msg += '\\n💰 Total: *' + formatRp(ctx.session.cart.total) + '*';
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '✅ Checkout', callback_data: 'checkout' }],[{ text: '🗑️ Kosongkan', callback_data: 'clear_cart' },{ text: '🔙', callback_data: 'back_menu' }]] } });
});
bot.action('clear_cart', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    ctx.session.cart = { items: [], total: 0 };
    await safeEdit(ctx, '🗑️ Keranjang dikosongkan.', { reply_markup: { inline_keyboard: [[{ text: '🛍️ Belanja', callback_data: 'belanja' }]] } });
});
bot.action('checkout', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!ctx.session.cart || !ctx.session.cart.items || !ctx.session.cart.items.length) return ctx.answerCbQuery('Keranjang kosong!', { show_alert: true });
    const invoiceId = genInvoiceId(ctx.from.id);
    const order = {
        id: invoiceId,
        userId: ctx.from.id,
        customerName: ctx.from.first_name,
        username: ctx.from.username,
        items: ctx.session.cart.items,
        total: ctx.session.cart.total,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    db.push(DB.orders, order);
    ctx.session.cart = { items: [], total: 0 };
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) return await safeEdit(ctx, '❌ Belum ada metode pembayaran.', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
    await safeEdit(ctx, '🧾 *INVOICE*\\n\\n🆔 ' + invoiceId + '\\n💰 Total: *' + formatRp(order.total) + '*\\n\\nPilih metode pembayaran:', {
        reply_markup: {
            inline_keyboard: [
                ...qrisList.map(q => [{ text: '💳 ' + q.nama, callback_data: 'bayar_' + invoiceId + '_' + q.kode }]),
                [{ text: '❌ Batal', callback_data: 'back_menu' }]
            ]
        }
    });
});

bot.action('cara_bayar', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) return await safeEdit(ctx, '❌ Belum ada metode pembayaran.', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
    let msg = '💳 *METODE PEMBAYARAN*\\n\\n';
    qrisList.forEach(q => {
        msg += '• *' + q.nama + '*';
        if (q.nomor) msg += '\\n  📋 No: ' + q.nomor;
        if (q.atas_nama) msg += '\\n  👤 A/N: ' + q.atas_nama;
        msg += '\\n\\n';
    });
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🛍️ Belanja', callback_data: 'belanja' },{ text: '🔙', callback_data: 'back_menu' }]] } });
});

bot.action(/^bayar_(.+?)_(.+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const kode = ctx.match[2];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    const qris = db.find(DB.qris, q => q.kode === kode);
    if (!order || !qris) return;
    db.update(DB.orders, o => o.id === invoiceId, o => { o.metodePembayaran = kode; o.status = 'waiting_payment'; });
    let msg = '✅ *ORDER DIBUAT!*\\n\\n🆔 ' + invoiceId + '\\n💰 *' + formatRp(order.total) + '*\\n💳 ' + qris.nama;
    if (qris.nomor) msg += '\\n📋 No: ' + qris.nomor;
    msg += '\\n\\n⏳ Kirim bukti pembayaran ke admin.';
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Menu', callback_data: 'back_menu' }]] } });
    if (qris.qrisImage) { try { await ctx.replyWithPhoto(qris.qrisImage, { caption: '💳 QR ' + qris.nama }); } catch(e) {} }
    try {
        await bot.telegram.sendMessage(OWNER_ID,
            '🛎️ *ORDER BARU!*\\n🆔 ' + invoiceId + '\\n👤 ' + (order.customerName||'-') + '\\n💰 ' + formatRp(order.total) + '\\n💳 ' + qris.nama,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Konfirmasi', callback_data: 'konfirm_' + invoiceId }]] } }
        );
    } catch(e) {}
});

bot.action('riwayat', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const orders = db.filter(DB.orders, o => o.userId === ctx.from.id).slice(-10).reverse();
    if (!orders.length) return await safeEdit(ctx, '📋 Belum ada order.', { reply_markup: { inline_keyboard: [[{ text: '🛍️ Belanja', callback_data: 'belanja' }]] } });
    let msg = '📋 *RIWAYAT ORDER*\\n\\n';
    orders.forEach(o => {
        const st = { pending:'⏳', waiting_payment:'💳', cancelled:'❌', completed:'🎉' }[o.status] || '❓';
        msg += st + ' ' + o.id + '\\n💰 ' + formatRp(o.total) + '\\n\\n';
    });
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
});

bot.action(/^konfirm_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order || order.status === 'completed') return ctx.reply('⚠️ Order tidak valid.');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'completed'; o.confirmedAt = new Date().toISOString(); });
    db.update(DB.customers, c => c.id === order.userId, c => { c.totalBelanja = (c.totalBelanja||0) + order.total; c.totalOrder = (c.totalOrder||0) + 1; });
    const stok = db.read(DB.akun_stok);
    let akunMsg = '';
    for (const item of (order.items||[])) {
        const idx = stok.findIndex(a => a.planId === item.planId && !a.used);
        if (idx !== -1) { stok[idx].used = true; stok[idx].orderId = invoiceId; stok[idx].usedAt = new Date().toISOString(); akunMsg += '• ' + item.planNama + '\\n' + stok[idx].akun + '\\n'; }
    }
    db.write(DB.akun_stok, stok);
    if (akunMsg) { try { await bot.telegram.sendMessage(order.userId, '🎉 *AKUN ANDA!*\\n\\n' + akunMsg + '\\n🔒 Jangan bagikan!', { parse_mode: 'Markdown' }); } catch(e) {} }
    else { try { await bot.telegram.sendMessage(order.userId, '🎉 Pembayaran dikonfirmasi!\\nAkun akan segera dikirim admin.', { parse_mode: 'Markdown' }); } catch(e) {} }
    ctx.reply('✅ Order ' + invoiceId + ' dikonfirmasi!', { parse_mode: 'Markdown' });
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const invoiceId = ctx.match[1];
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'cancelled'; o.cancelledAt = new Date().toISOString(); });
    ctx.reply('✅ Order ' + invoiceId + ' dibatalkan.', { parse_mode: 'Markdown' });
});

bot.action('admin', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const pending = db.filter(DB.orders, o => o.status === 'waiting_payment').length;
    await safeEdit(ctx, '⚙️ *ADMIN PANEL*\\n\\n⏳ Pending: *' + pending + '*\\n👥 Pelanggan: ' + db.read(DB.customers).length + '\\n📦 Order: ' + db.read(DB.orders).length, {
        reply_markup: { inline_keyboard: [
            [{ text: '⏳ Order Pending', callback_data: 'pending_orders' }, { text: '📊 Statistik', callback_data: 'stats' }],
            [{ text: '💳 QRIS', callback_data: 'admin_qris' }],
            [{ text: '📥 Input Stok', callback_data: 'clone_input_stok' }, { text: '📦 Lihat Stok', callback_data: 'clone_lihat_stok' }],
            [{ text: '🔙 Menu', callback_data: 'back_menu' }]
        ]}
    });
});

bot.action('pending_orders', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const orders = db.filter(DB.orders, o => o.status === 'waiting_payment').slice(-10).reverse();
    if (!orders.length) return await safeEdit(ctx, '✅ Tidak ada order pending.', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'admin' }]] } });
    let msg = '⏳ *ORDER PENDING*\\n\\n';
    orders.forEach(o => { msg += o.id + '\\n👤 ' + (o.customerName||'-') + '\\n💰 *' + formatRp(o.total) + '*\\n\\n'; });
    const btns = orders.map(o => [{ text: '✅ ' + o.id.slice(-6), callback_data: 'konfirm_' + o.id }, { text: '❌ Batal', callback_data: 'cancel_' + o.id }]);
    btns.push([{ text: '🔙', callback_data: 'admin' }]);
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: btns } });
});

bot.action('admin_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const qrisList = db.read(DB.qris);
    let msg = '💳 *KELOLA QRIS*\\n\\n';
    if (!qrisList.length) {
        msg += '_Belum ada QRIS._\\n\\n';
    } else {
        qrisList.forEach(q => {
            msg += (q.aktif?'✅':'❌') + ' *' + q.nama + '*\\n';
            msg += '   Kode: ' + q.kode + '\\n';
            if (q.nomor) msg += '   No: ' + q.nomor + '\\n';
            msg += '   Gambar: ' + (q.qrisImage ? '✅' : '❌ Belum upload') + '\\n\\n';
        });
    }
    msg += '*Perintah:*\\n/tambah_qris [kode] [nama] [nomor]\\n/hapus_qris [kode]\\n/upload_qris [kode]\\n/list_qris';
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'admin' }]] } });
});

bot.action('stats', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const orders = db.read(DB.orders);
    const rev = orders.filter(o => o.status === 'completed').reduce((s,o)=>s+o.total,0);
    await safeEdit(ctx, '📊 *STATISTIK*\\n\\n📦 Order: ' + orders.length + '\\n✅ Selesai: ' + orders.filter(o=>o.status==='completed').length + '\\n💰 Revenue: *' + formatRp(rev) + '*', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'admin' }]] } });
});

bot.action('bantuan', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await safeEdit(ctx, '❓ *BANTUAN*\\n\\n1. Pilih 🛍️ Belanja\\n2. Pilih produk\\n3. Checkout & bayar\\n4. Akun otomatis dikirim\\n\\n/cekorder [id] — Cek status', { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
});

bot.action('profil', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const cust = db.find(DB.customers, c => c.id === ctx.from.id);
    if (!cust) return;
    await safeEdit(ctx, '👤 *PROFIL*\\n\\n🔖 ' + cust.first_name + '\\n🆔 ' + cust.id + '\\n💰 Total Belanja: *' + formatRp(cust.totalBelanja||0) + '*\\n📦 Order: ' + (cust.totalOrder||0), { reply_markup: { inline_keyboard: [[{ text: '🔙', callback_data: 'back_menu' }]] } });
});


bot.command('tambah_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Format: /tambah_qris [kode] [nama] [nomor]');
    const kode = args[0], nama = args[1], nomor = args[2] || null;
    db.upsert(DB.qris, q => q.kode === kode, { kode, nama, nomor, aktif: true, qrisImage: null, createdAt: new Date().toISOString() });
    ctx.reply('✅ QRIS *' + nama + '* ditambahkan!\\n\\nUpload gambar QR dengan cara:\\nKirim gambar → reply → /upload\\_qris ' + kode, { parse_mode: 'Markdown' });
});
bot.command('hapus_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('\u274c Akses ditolak!');
    const kode = (ctx.message.text.split(' ')[1] || '').trim().replace(/[()]/g, '');
    if (!kode) return ctx.reply('Format: /hapus_qris [kode]\\nContoh: /hapus_qris pay\\n\\nKirim /list_qris untuk lihat semua kode.');
    const n = db.remove(DB.qris, q => q.kode === kode);
    ctx.reply(n ? '\u2705 QRIS ' + kode + ' dihapus.' : '\u274c QRIS tidak ditemukan.\\nKirim /list_qris untuk lihat kode yang tersedia.');
});
bot.command('list_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('\u274c Akses ditolak!');
    const qrisList = db.read(DB.qris);
    if (!qrisList.length) return ctx.reply('\u274c Belum ada QRIS.\\nTambah: /tambah_qris [kode] [nama] [nomor]');
    await ctx.reply('\ud83d\udcb3 DAFTAR QRIS (' + qrisList.length + ')\\nKlik kode di bawah untuk copy:');
    for (const q of qrisList) {
        const status = q.qrisImage ? '\u2705 Ada gambar' : '\u274c Belum ada gambar';
        const msg = (q.aktif ? '\u2705' : '\u274c') + ' *' + q.nama + '*\\n' +
            '\ud83d\udd11 Kode: \`' + q.kode.trim() + '\`\\n' +
            (q.nomor ? '\ud83d\udccb No: ' + q.nomor + '\\n' : '') +
            '\ud83d\uddbc Gambar: ' + status + '\\n\\n' +
            '_/hapus\\_qris ' + q.kode.trim() + '_';
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    }
});
bot.command('bersih_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('\u274c Akses ditolak!');
    const before = db.read(DB.qris).length;
    db.remove(DB.qris, q => !q.qrisImage);
    const after = db.read(DB.qris).length;
    ctx.reply('\u2705 ' + (before - after) + ' QRIS tanpa gambar dihapus.\\nSisa: ' + after + ' QRIS.');
});
bot.command('upload_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const kode = ctx.message.text.split(' ')[1];
    if (!kode) return ctx.reply('Format: Reply ke gambar lalu ketik /upload_qris [kode]');
    const qris = db.find(DB.qris, q => q.kode === kode);
    if (!qris) return ctx.reply('❌ QRIS tidak ditemukan! Gunakan /tambah_qris dulu.');
    if (!ctx.message.reply_to_message?.photo) return ctx.reply('❌ Reply ke GAMBAR dulu, lalu ketik perintah ini!');
    const photo = ctx.message.reply_to_message.photo;
    const fileId = photo[photo.length - 1].file_id;
    db.update(DB.qris, q => q.kode === kode, q => { q.qrisImage = fileId; });
    await ctx.reply('✅ QR Code untuk *' + qris.nama + '* berhasil diupload!', { parse_mode: 'Markdown' });
    try { await ctx.replyWithPhoto(fileId, { caption: '🖼️ Preview QR — ' + qris.nama }); } catch(e) {}
});
bot.command('input', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const text = ctx.message.text.split('\\n').slice(1).join('\\n').trim();
    if (!text) return ctx.reply('Format:\\n/input\\nKategori | Produk | NamaPaket | Harga | Deskripsi\\n\\nContoh:\\nNetflix | Netflix | 1 Bulan | 15000\\nNetflix | Netflix | 3 Bulan | 40000\\nCapcut | Capcut | 1 Bulan | 10000');
    const baris = text.split('\\n').map(b => b.trim()).filter(b => b.length > 0);
    let ok = 0, fail = 0;
    for (const brs of baris) {
        const parts = brs.split('|').map(p => p.trim());
        if (parts.length < 4) { fail++; continue; }
        const namaKat = parts[0], namaProd = parts[1], namaPaket = parts[2], hargaStr = parts[3];
        const desc = parts[4] || '';
        const harga = parseInt(hargaStr.replace(/\\D/g, ''));
        if (!namaKat || !namaProd || !namaPaket || isNaN(harga)) { fail++; continue; }
        // Cari atau buat kategori
        let kat = db.find(DB.categories, c => c.nama.toLowerCase() === namaKat.toLowerCase());
        if (!kat) { const katId = uuidv4().slice(0,8); kat = { id: katId, nama: namaKat, icon: '📦', aktif: true, createdAt: new Date().toISOString() }; db.push(DB.categories, kat); }
        // Cari produk yang sudah ada (sama nama & kategori) — JANGAN buat baru kalau sudah ada
        let prod = db.find(DB.products, p => p.nama.toLowerCase() === namaProd.toLowerCase() && p.kategori === kat.id);
        if (!prod) {
            const prodId = uuidv4().slice(0,8);
            prod = { id: prodId, nama: namaProd, deskripsi: desc, kategori: kat.id, aktif: true, createdAt: new Date().toISOString() };
            db.push(DB.products, prod);
        }
        // Tambahkan plan baru ke produk tersebut
        const planId = uuidv4().slice(0,8);
        db.push(DB.plans, { id: planId, produk_id: prod.id, nama: namaPaket, harga, durasi: 30, aktif: true, createdAt: new Date().toISOString() });
        ok++;
    }
    ctx.reply('✅ Berhasil: ' + ok + ' | ❌ Gagal: ' + fail + '\\n\\n_Cek produk dengan /list_produk_', { parse_mode: 'Markdown' });
});
bot.command('cekorder', async (ctx) => {
    const invoiceId = ctx.message.text.split(' ')[1];
    if (!invoiceId) return ctx.reply('Format: /cekorder [id]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.userId !== ctx.from.id && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Bukan order Anda!');
    const statusMap = { pending:'⏳ Menunggu', waiting_payment:'💳 Menunggu Pembayaran', paid:'✅ Dibayar', cancelled:'❌ Dibatalkan', completed:'🎉 Selesai' };
    ctx.reply('🧾 ' + order.id + '\\n📊 *' + (statusMap[order.status]||order.status) + '*\\n💰 ' + formatRp(order.total), { parse_mode: 'Markdown' });
});

bot.command('tambah_admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return ctx.reply('Format: /tambah_admin [user_id] [nama]');
    const userId = parseInt(args[0]);
    const nama = args.slice(1).join(' ') || 'Admin';
    if (isNaN(userId)) return ctx.reply('❌ user_id harus angka!');
    if (db.find(DB.admins, a => a.id === userId)) return ctx.reply('❌ User sudah jadi admin!');
    db.push(DB.admins, { id: userId, nama, aktif: true, addedAt: new Date().toISOString() });
    ctx.reply('✅ *' + nama + '* (' + userId + ') ditambahkan sebagai admin!', { parse_mode: 'Markdown' });
});

bot.command('hapus_admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const userId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(userId)) return ctx.reply('Format: /hapus_admin [user_id]');
    const n = db.remove(DB.admins, a => a.id === userId);
    ctx.reply(n ? '✅ Admin ' + userId + ' dihapus.' : '❌ Admin tidak ditemukan.');
});

bot.command('list_admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const admins = db.read(DB.admins);
    if (!admins.length) return ctx.reply('📭 Belum ada admin.');
    let msg = '👮 *DAFTAR ADMIN*\\n\\nTotal: ' + admins.length + '\\n\\n';
    admins.forEach(a => { msg += (a.aktif !== false ? '✅' : '❌') + ' *' + (a.nama||'-') + '* (' + a.id + ')\\n'; });
    msg += '\\n/tambah_admin [user_id] [nama]\\n/hapus_admin [user_id]';
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('konfirmasi', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const invoiceId = ctx.message.text.split(' ')[1];
    if (!invoiceId) return ctx.reply('Format: /konfirmasi [invoice_id]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.status === 'completed') return ctx.reply('⚠️ Order sudah dikonfirmasi!');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'completed'; o.confirmedAt = new Date().toISOString(); });
    db.update(DB.customers, c => c.id === order.userId, c => { c.totalBelanja = (c.totalBelanja||0) + order.total; c.totalOrder = (c.totalOrder||0) + 1; });
    const stok = db.read(DB.akun_stok);
    let akunMsg = '';
    for (const item of (order.items||[])) {
        const idx = stok.findIndex(a => a.planId === item.planId && !a.used);
        if (idx !== -1) { stok[idx].used = true; stok[idx].orderId = invoiceId; stok[idx].usedAt = new Date().toISOString(); akunMsg += item.planNama + '\\n' + stok[idx].akun + '\\n'; }
    }
    db.write(DB.akun_stok, stok);
    if (akunMsg) { try { await bot.telegram.sendMessage(order.userId, '🎉 *AKUN ANDA!*\\n\\n' + akunMsg + '\\n🔒 Jangan bagikan!' + WATERMARK, { parse_mode: 'Markdown' }); } catch(e) {} }
    else { try { await bot.telegram.sendMessage(order.userId, '🎉 Pembayaran dikonfirmasi!\\nAkun akan segera dikirim admin.' + WATERMARK, { parse_mode: 'Markdown' }); } catch(e) {} }
    ctx.reply('✅ Order ' + invoiceId + ' dikonfirmasi!');
});

bot.command('batal_order', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    const invoiceId = args[0];
    if (!invoiceId) return ctx.reply('Format: /batal_order [invoice_id]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    const alasan = args.slice(1).join(' ') || 'Dibatalkan admin';
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = alasan; });
    try { await bot.telegram.sendMessage(order.userId, '❌ *ORDER DIBATALKAN*\\n\\n🆔 ' + invoiceId + '\\nAlasan: ' + alasan, { parse_mode: 'Markdown' }); } catch(e) {}
    ctx.reply('✅ Order ' + invoiceId + ' dibatalkan.');
});

// ==================== KELOLA PRODUK & KATEGORI (CLONE) ====================
bot.command('list_produk', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const products = db.read(DB.products);
    if (!products.length) return ctx.reply('❌ Belum ada produk.');
    let msg = '📦 *DAFTAR PRODUK*\\n\\n';
    products.forEach(p => {
        const plans = db.filter(DB.plans, pl => pl.produk_id === p.id);
        msg += (p.aktif !== false ? '✅' : '❌') + ' *' + p.nama + '*\\n';
        msg += '   ID: ' + p.id + '\\n';
        msg += '   Kategori: ' + (db.find(DB.categories, c => c.id === p.kategori)?.nama || '-') + '\\n';
        msg += '   Plan: ' + plans.length + '\\n\\n';
    });
    msg += '/hapus_produk [id] — hapus produk\\n/hapus_plan [plan_id] — hapus satu plan';
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('list_kategori', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const cats = db.read(DB.categories);
    if (!cats.length) return ctx.reply('❌ Belum ada kategori.');
    let msg = '🗂️ *DAFTAR KATEGORI*\\n\\n';
    cats.forEach(c => {
        const jumlahProd = db.filter(DB.products, p => p.kategori === c.id).length;
        msg += (c.aktif !== false ? '✅' : '❌') + ' ' + (c.icon || '📦') + ' *' + c.nama + '*\\n';
        msg += '   ID: ' + c.id + '\\n';
        msg += '   Produk: ' + jumlahProd + '\\n\\n';
    });
    msg += '/hapus_kategori [id] — hapus kategori';
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ==================== INPUT STOK AKUN (CLONE) ====================
bot.command('input_stok', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const planId = ctx.message.text.split(' ')[1];
    if (!planId) {
        // Tampilkan daftar semua plan beserta stok
        const plans = db.read(DB.plans);
        if (!plans.length) return ctx.reply('❌ Belum ada plan/produk.');
        let msg = '📋 *DAFTAR PLAN & STOK*\\n\\n';
        plans.forEach(pl => {
            const stok = hitungStok(pl.id);
            msg += '• ' + pl.nama + ' — \`' + pl.id + '\` (stok: ' + stok + ')\\n';
        });
        msg += '\\nGunakan: /input_stok [plan_id] untuk menambah stok';
        return ctx.reply(msg, { parse_mode: 'Markdown' });
    }
    const plan = db.find(DB.plans, p => p.id === planId);
    if (!plan) return ctx.reply('❌ Plan tidak ditemukan! Kirim /input_stok untuk melihat daftar plan.');
    ctx.session.action = 'input_stok_clone';
    ctx.session.inputStokPlanId = planId;
    ctx.reply('📥 *INPUT STOK — ' + plan.nama + '*\\n\\nKirim daftar akun sekarang.\\nSatu baris = satu akun\\nContoh:\\n\`\`\`\\nuser1|pass1\\nuser2|pass2\\n\`\`\`\\n\\n_Kirim /batal untuk membatalkan._', { parse_mode: 'Markdown' });
});

// Callback: tampilkan daftar plan untuk pilih input stok
bot.action('clone_input_stok', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const plans = db.read(DB.plans);
    if (!plans.length) return await safeEdit(ctx, '❌ Belum ada plan/produk.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'admin' }]] } });
    const btns = plans.map(pl => {
        const stok = hitungStok(pl.id);
        return [{ text: '📥 ' + pl.nama + ' (stok: ' + stok + ')', callback_data: 'clone_pilih_stok_' + pl.id }];
    });
    btns.push([{ text: '🔙 Admin', callback_data: 'admin' }]);
    await safeEdit(ctx, '📥 *PILIH PLAN UNTUK INPUT STOK:*', { reply_markup: { inline_keyboard: btns } });
});

bot.action(/^clone_pilih_stok_(.+)$/, async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const planId = ctx.match[1];
    const plan = db.find(DB.plans, p => p.id === planId);
    if (!plan) return ctx.reply('❌ Plan tidak ditemukan!');
    ctx.session.action = 'input_stok_clone';
    ctx.session.inputStokPlanId = planId;
    await safeEdit(ctx, '📥 *INPUT STOK — ' + plan.nama + '*\\n\\nKirim daftar akun sekarang.\\nSatu baris = satu akun\\nContoh:\\n\`\`\`\\nuser1|pass1\\nuser2|pass2\\n\`\`\`\\n\\n_Kirim /batal untuk membatalkan._', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'clone_input_stok' }]] }
    });
});

// Callback: tampilkan semua stok per plan
bot.action('clone_lihat_stok', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌', true);
    await safeAnswerCbQuery(ctx);
    const plans = db.read(DB.plans);
    if (!plans.length) return await safeEdit(ctx, '❌ Belum ada plan/produk.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Admin', callback_data: 'admin' }]] } });
    let msg = '📦 *STOK AKUN*\\n\\n';
    let total = 0;
    plans.forEach(pl => {
        const stok = hitungStok(pl.id);
        total += stok;
        const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
        msg += icon + ' ' + pl.nama + ': *' + stok + '* tersedia\\n';
    });
    msg += '\\n📊 Total tersedia: *' + total + ' akun*';
    await safeEdit(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📥 Input Stok', callback_data: 'clone_input_stok' }, { text: '🔄 Refresh', callback_data: 'clone_lihat_stok' }],
        [{ text: '🔙 Admin', callback_data: 'admin' }]
    ]}});
});

// Text handler: tangkap input stok akun clone
bot.on('text', async (ctx) => {
    if (!ctx.session || ctx.session.action !== 'input_stok_clone') return;
    if (!isAdminOrOwner(ctx.from.id)) { ctx.session.action = null; return; }
    const planId = ctx.session.inputStokPlanId;
    if (!planId) { ctx.session.action = null; return ctx.reply('❌ Session tidak valid, ulangi /input_stok'); }
    const text = ctx.message.text.trim();
    if (text === '/batal') {
        ctx.session.action = null;
        ctx.session.inputStokPlanId = null;
        return ctx.reply('❌ Input stok dibatalkan.');
    }
    const plan = db.find(DB.plans, p => p.id === planId);
    const listAkun = text.split('\\n').map(a => a.trim()).filter(a => a.length > 0);
    if (!listAkun.length) return ctx.reply('❌ Tidak ada akun yang valid. Coba lagi atau kirim /batal');
    const stok = db.read(DB.akun_stok);
    let added = 0;
    for (const akun of listAkun) {
        stok.push({
            id: 'AKN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,5).toUpperCase(),
            planId,
            akun,
            used: false,
            orderId: null,
            usedAt: null,
            addedAt: new Date().toISOString()
        });
        added++;
    }
    db.write(DB.akun_stok, stok);
    ctx.session.action = null;
    ctx.session.inputStokPlanId = null;
    ctx.reply('✅ *' + added + ' akun* ditambahkan ke stok ' + (plan ? '*' + plan.nama + '*' : '') + '!\\n\\nTotal stok sekarang: *' + hitungStok(planId) + '*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
            [{ text: '📥 Input Lagi', callback_data: 'clone_pilih_stok_' + planId }],
            [{ text: '📦 Lihat Stok', callback_data: 'clone_lihat_stok' }]
        ]}
    });
});


// ==================== AI FEATURE (CLONE) ====================

async function callCloneAI(userMessage, systemPrompt) {
    const apiKey = config.aiKey;
    if (!apiKey) return null;
    try {
        const axios = require('axios');
        const res = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: config.aiModel || 'mistral-small-latest',
            max_tokens: 512,
            messages: [
                { role: 'system', content: systemPrompt || config.aiPrompt || 'Kamu adalah customer service toko ' + config.name + '. Jawab ramah, singkat, bahasa Indonesia.' },
                { role: 'user', content: userMessage }
            ]
        }, {
            headers: { 'Authorization': 'Bearer ' + apiKey, 'content-type': 'application/json' },
            timeout: 20000
        });
        return res.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch(e) { console.error('[AI]', e.response?.data || e.message); return null; }
}

bot.command('tanya', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ AI Key belum diset!\\n/set_ai_key [key]');
    const q = ctx.message.text.split(' ').slice(1).join(' ');
    if (!q) return ctx.reply('Format: /tanya [pertanyaan]');
    const t = await ctx.reply('🤖 _Berpikir..._', { parse_mode: 'Markdown' });
    const ans = await callCloneAI(q, 'Kamu asisten AI admin toko online. Jawab jelas dan membantu dalam bahasa Indonesia.');
    try { await ctx.telegram.deleteMessage(ctx.chat.id, t.message_id); } catch(e) {}
    if (!ans) return ctx.reply('❌ AI error. Cek API key.');
    ctx.reply('🤖 *Jawaban AI:*\\n\\n' + ans, { parse_mode: 'Markdown' });
});

bot.command('set_ai_key', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const key = ctx.message.text.split(' ')[1];
    if (!key) return ctx.reply('Format: /set_ai_key [mistral_api_key]\\nDapat key gratis di: https://console.mistral.ai');
    config.aiKey = key;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    try { await ctx.deleteMessage(); } catch(e) {}
    ctx.reply('✅ AI Key disimpan! Aktifkan: /ai_on');
});

bot.command('set_ai_prompt', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const p = ctx.message.text.split(' ').slice(1).join(' ');
    if (!p) return ctx.reply('Format: /set_ai_prompt [prompt]');
    config.aiPrompt = p;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ Prompt AI disimpan!');
});

bot.command('ai_on', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ Set API key dulu! /set_ai_key [key]');
    config.aiEnabled = true;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI CS *AKTIF*!', { parse_mode: 'Markdown' });
});
bot.command('ai_off', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    config.aiEnabled = false;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('🔴 AI CS *NONAKTIF*.', { parse_mode: 'Markdown' });
});
bot.command('ai_grup_on', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ Set API key dulu!');
    config.aiGroupEnabled = true;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI aktif di grup!');
});
bot.command('ai_grup_off', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    config.aiGroupEnabled = false;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('🔴 AI grup nonaktif.');
});
bot.command('ai_grup_full', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ Set API key dulu!');
    config.aiGroupEnabled = true;
    config.aiGroupFull = true;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('\ud83e\udd16 AI Grup *Full Mode* aktif! AI balas semua pesan terkait toko.\\n\\nKembali normal: /ai_grup_normal', { parse_mode: 'Markdown' });
});
bot.command('ai_grup_normal', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    config.aiGroupFull = false;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI Grup mode normal (hanya balas mention/reply).');
});

bot.command('info_ai', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    ctx.reply('🤖 *STATUS AI*\\n\\n🔑 Key: ' + (config.aiKey ? '✅' : '❌') + '\\n💬 Private: ' + (config.aiEnabled ? '🟢 Aktif' : '🔴 Off') + '\\n👥 Grup: ' + (config.aiGroupEnabled ? '🟢 Aktif' : '🔴 Off') + '\\n\\n/ai_on /ai_off /ai_grup_on /ai_grup_off\\n/set_ai_key /set_ai_prompt /tanya', { parse_mode: 'Markdown' });
});

bot.on('message', async (ctx, next) => {
    if (!ctx.message?.text) return next();
    if (ctx.chat.type !== 'private') return next();
    if (!config.aiEnabled || !config.aiKey) return next();
    if (ctx.session?.action) return next();
    const t = ctx.message.text.trim();
    if (t.startsWith('/')) return next();
    const storeTriggers = ['list', 'katalog', 'bayar', 'pay', 'qris', 'harga'];
    if (storeTriggers.some(x => t.toLowerCase().includes(x))) return next();
    try {
        await ctx.sendChatAction('typing');
        const prods = db.read(DB.products).map(p => p.nama).join(', ');
        const sys = config.aiPrompt || 'Kamu CS toko ' + config.name + '. Produk: ' + (prods || '-') + '. Jawab ramah, singkat, bahasa Indonesia.';
        const ans = await callCloneAI(t, sys);
        if (!ans) return next();
        ctx.reply(ans, { parse_mode: 'Markdown' });
    } catch(e) { return next(); }
});

bot.on('message', async (ctx, next) => {
    if (!ctx.message?.text) return next();
    if (ctx.chat.type === 'private') return next();
    if (!config.aiGroupEnabled || !config.aiKey) return next();
    if (ctx.session?.action) return next();
    const t = ctx.message.text.trim();
    if (t.startsWith('/')) return next();
    let botUsername = '';
    try { const me = await bot.telegram.getMe(); botUsername = me.username || ''; } catch(e) {}
    const botNameLower = (config.name || '').toLowerCase();
    const isReply = ctx.message.reply_to_message?.from?.is_bot && ctx.message.reply_to_message?.from?.username === botUsername;
    const isMentioned = botUsername && t.toLowerCase().includes('@' + botUsername.toLowerCase());
    const isCalled = botNameLower && t.toLowerCase().includes(botNameLower);
    const isFullMode = config.aiGroupFull;
    if (!isFullMode && !isReply && !isMentioned && !isCalled) return next();
    const clean = t.replace(new RegExp('@' + botUsername, 'gi'), '').trim();
    if (!clean) return next();
    try {
        await ctx.sendChatAction('typing');
        const prods = db.read(DB.products).map(p => p.nama).join(', ');
        const sys = config.aiPrompt || (isFullMode
            ? 'Kamu CS toko ' + config.name + ' di grup. Produk: ' + (prods||'-') + '. PENTING: Hanya balas kalau pesan berkaitan dengan toko/produk/order/harga. Kalau tidak relevan balas SKIP saja. Jawab singkat, ramah, Indonesia.'
            : 'Kamu asisten toko ' + config.name + ' di grup. Jawab singkat, ramah, Indonesia. Produk: ' + (prods||'-'));
        const ans = await callCloneAI(clean, sys);
        if (!ans) return next();
        if (isFullMode && ans.trim().toUpperCase() === 'SKIP') return next();
        ctx.reply(ans, { reply_to_message_id: ctx.message.message_id });
    } catch(e) { return next(); }
});



// ==================== TAG ALL MEMBER ====================

bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx)) return next();
    if (!ctx.message?.text) return next();
    const text = ctx.message.text.trim();
    const lower = text.toLowerCase();
    const isTagAll   = lower.startsWith('.tagall') || lower.startsWith('.tag ');
    const isTagAdmin = lower.startsWith('.tagadmin');
    if (!isTagAll && !isTagAdmin) return next();

    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('\u274c Hanya admin grup!');

    const parts = text.split(' ').slice(1);
    if (!parts.length) return ctx.reply(
        'Format: .tagall [emot] [pesan]\\n' +
        'Contoh: .tagall \ud83d\ude18 netflix 1k stok terbatas!\\n\\n' +
        'Custom jumlah per pesan:\\n' +
        '.tagall \ud83d\ude18 20 netflix 1k stok terbatas!\\n\\n' +
        'Tag admin: .tagadmin ada order masuk!'
    );

    const emojiRegex = /^\\p{Emoji}/u;
    let emot = '\ud83d\ude18';
    let perPage = 10;
    let msgStart = 0;

    if (parts[0] && [...parts[0]].length <= 2 && /\\p{Emoji}/u.test(parts[0])) {
        emot = parts[0];
        msgStart = 1;
        if (parts[1] && /^\\d+$/.test(parts[1])) {
            perPage = Math.min(50, Math.max(10, parseInt(parts[1])));
            msgStart = 2;
        }
    } else if (/^\\d+$/.test(parts[0])) {
        perPage = Math.min(50, Math.max(10, parseInt(parts[0])));
        msgStart = 1;
    }

    const pesan = parts.slice(msgStart).join(' ');

    if (isTagAdmin) {
        try {
            const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
            const adminMentions = admins
                .filter(a => !a.user.is_bot)
                .map(a => a.user.username ? '@' + a.user.username : a.user.first_name);
            if (!adminMentions.length) return ctx.reply('\u274c Tidak ada admin yang bisa di-tag.');
            const msg = emot + ' ' + (pesan || 'ada pesan untuk admin') + '\\n\\n' + adminMentions.join(' ');
            await ctx.reply(msg);
        } catch(e) { ctx.reply('\u274c Gagal tag admin: ' + e.message); }
        return;
    }

    const customers = db.read(DB.customers).filter(c => c.username);
    if (!customers.length) return ctx.reply('\u274c Belum ada data member. Member harus pernah chat ke bot dulu.');

    const mentions = customers.map(c => '@' + c.username);
    const total = mentions.length;
    const chunks = [];
    for (let i = 0; i < mentions.length; i += perPage) chunks.push(mentions.slice(i, i + perPage));

    await ctx.reply('\ud83d\udce2 Blast ke ' + total + ' member\\n\ud83d\udce6 ' + chunks.length + ' pesan x ' + perPage + ' tag\\n\u23f1 Estimasi: ' + (chunks.length * 2) + ' detik');

    for (let i = 0; i < chunks.length; i++) {
        const msg = emot + ' ' + (pesan ? pesan + '\\n\\n' : '') + chunks[i].join(' ');
        try { await ctx.reply(msg); } catch(e) { console.error('[TagAll] chunk ' + i, e.message); }
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    await ctx.reply('\u2705 Selesai blast ke ' + total + ' member!');
});

// ==================== MONITORING & RNK ====================

const RNK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const rnkTimers = new Map();

const MONITORING_TEMPLATE = (produk) =>
    '📋 *FORM MONITORING ' + produk.toUpperCase() + '*\\n\\n' +
    '👤 Nama & USN Seller :\\n' +
    '👤 Nama & USN Buyer :\\n' +
    '📱 No WA Buyer (aktif) :\\n' +
    '📱 No WA Seller (aktif) :\\n' +
    '⏳ Durasi :\\n' +
    '📦 Plan (1u/2u/semi/share) :\\n' +
    '📱 Device & Lokasi :\\n' +
    '📧 Email :\\n' +
    '🖼️ SS Buyer :\\n\\n' +
    '_Isi semua field lalu kirim ke grup_\\n' +
    '_Wajib posting #rnk di grup dalam 24 jam!_';

// Trigger .net .netflix .disney dll → kirim template form
bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx)) return next();
    if (!ctx.message?.text) return next();
    const text = ctx.message.text.trim();
    const lower = text.toLowerCase();
    const triggerMap = {
        '.net': 'Netflix', '.netflix': 'Netflix',
        '.disney': 'Disney+', '.spotify': 'Spotify',
        '.capcut': 'Capcut', '.canva': 'Canva',
        '.monitor': text.split(' ').slice(1).join(' ') || 'Produk',
        '.format': text.split(' ').slice(1).join(' ') || 'Produk',
    };
    const key = Object.keys(triggerMap).find(t => lower === t || lower.startsWith(t + ' '));
    if (!key) return next();
    const produk = triggerMap[key];
    await ctx.reply(MONITORING_TEMPLATE(produk), { parse_mode: 'Markdown' });
});

// Deteksi form monitoring dikirim customer di grup
bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx)) return next();
    if (!ctx.message?.text) return next();
    const text = ctx.message.text;
    if (!text.includes('Nama & USN') || !text.includes('No WA')) return next();

    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;
    const rKey = userId + '_' + chatId;

    const entry = {
        id: Date.now().toString(),
        userId, chatId, username,
        formData: text,
        timestamp: new Date().toISOString(),
        rnkStatus: 'pending',
        messageId: ctx.message.message_id
    };
    db.push(DB.monitoring, entry);

    await ctx.reply(
        '✅ Form diterima ' + username + '!\\n\\n' +
        '⚠️ *WAJIB* posting *#rnk* di grup dalam *24 jam*\\n' +
        'Kalau tidak, kamu akan otomatis di-mute! 🔇',
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );

    db.upsert(DB.rnk_pending, r => r.rKey === rKey, {
        rKey, userId, chatId, username,
        deadline: Date.now() + RNK_TIMEOUT_MS,
        monitoringId: entry.id
    });

    if (rnkTimers.has(rKey)) clearTimeout(rnkTimers.get(rKey));
    const timer = setTimeout(async () => {
        const p = db.find(DB.rnk_pending, r => r.rKey === rKey);
        if (!p) return;
        try {
            const until = Math.floor(Date.now() / 1000) + 86400;
            await bot.telegram.restrictChatMember(chatId, userId, {
                permissions: { can_send_messages: false, can_send_media_messages: false, can_send_polls: false, can_send_other_messages: false },
                until_date: until
            });
            await bot.telegram.sendMessage(chatId,
                '🔇 ' + username + ' otomatis di-mute karena belum posting *#rnk* dalam 24 jam!\\nHubungi admin untuk di-unmute.',
                { parse_mode: 'Markdown' }
            );
        } catch(e) { console.error('[AutoMute]', e.message); }
        db.remove(DB.rnk_pending, r => r.rKey === rKey);
        db.update(DB.monitoring, m => m.id === entry.id, m => { m.rnkStatus = 'muted'; });
        rnkTimers.delete(rKey);
    }, RNK_TIMEOUT_MS);
    rnkTimers.set(rKey, timer);
});

// Deteksi #rnk di grup → clear pending (cukup userId, bisa dari grup manapun)
bot.on('message', async (ctx, next) => {
    if (!isGroup(ctx)) return next();
    if (!ctx.message?.text) return next();
    if (!ctx.message.text.toLowerCase().includes('#rnk')) return next();

    const userId = ctx.from.id;
    const username = ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name;

    // Cari pending berdasarkan userId saja, tidak peduli dari grup mana
    const p = db.find(DB.rnk_pending, r => r.userId === userId);
    if (!p) return next();

    const rKey = p.rKey; // ambil rKey asli dari data pending

    if (rnkTimers.has(rKey)) { clearTimeout(rnkTimers.get(rKey)); rnkTimers.delete(rKey); }
    db.remove(DB.rnk_pending, r => r.userId === userId);
    db.update(DB.monitoring, m => m.userId === userId && m.rnkStatus === 'pending',
        m => { m.rnkStatus = 'done'; m.rnkAt = new Date().toISOString(); m.rnkChatId = ctx.chat.id; });

    await ctx.reply(
        '✅ *RNK ' + username + ' sudah tercatat!*\\nTerima kasih sudah posting review 🙏',
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
});

// /rekap_monitoring
bot.command('rekap_monitoring', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    const filterStatus = args[0] || 'all';
    let data = db.read(DB.monitoring);
    if (isGroup(ctx)) data = data.filter(m => m.chatId === ctx.chat.id);
    if (filterStatus !== 'all') data = data.filter(m => m.rnkStatus === filterStatus);
    data = data.slice(-20);
    if (!data.length) return ctx.reply('📋 Belum ada data monitoring.');
    const icons = { pending: '⏳', done: '✅', muted: '🔇' };
    let msg = '📋 *REKAP MONITORING* (' + filterStatus.toUpperCase() + ')\\n\\n';
    data.forEach((m, i) => {
        const tgl = new Date(m.timestamp).toLocaleDateString('id-ID');
        msg += (i+1) + '. ' + (icons[m.rnkStatus]||'❓') + ' ' + m.username + ' — ' + tgl + '\\n';
    });
    msg += '\\n_Total: ' + data.length + ' data_\\n_Filter: /rekap_monitoring [all/pending/done/muted]_';
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /pending_rnk
bot.command('pending_rnk', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const pending = db.read(DB.rnk_pending);
    if (!pending.length) return ctx.reply('✅ Tidak ada yang pending RNK!');
    let msg = '⏳ *PENDING RNK* (' + pending.length + ')\\n\\n';
    pending.forEach((p, i) => {
        const sisa = Math.max(0, p.deadline - Date.now());
        const jam = Math.floor(sisa / 3600000);
        const menit = Math.floor((sisa % 3600000) / 60000);
        msg += (i+1) + '. ' + p.username + ' — sisa ' + jam + 'j ' + menit + 'm\\n';
    });
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /trigger_monitor — lihat daftar trigger
bot.command('trigger_monitor', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('\u274c Akses ditolak!');
    ctx.reply(
        '\ud83d\udccb *TRIGGER FORM MONITORING*\\n\\n' +
        '*Trigger yang tersedia:*\\n' +
        '.net atau .netflix \u2192 Form Netflix\\n' +
        '.disney \u2192 Form Disney+\\n' +
        '.spotify \u2192 Form Spotify\\n' +
        '.capcut \u2192 Form Capcut\\n' +
        '.canva \u2192 Form Canva\\n' +
        '.monitor [produk] \u2192 Form custom\\n' +
        '.format [produk] \u2192 Form custom\\n\\n' +
        '_Ketik trigger di grup untuk kirim form_\\n' +
        '_Customer wajib #rnk dalam 24 jam_',
        { parse_mode: 'Markdown' }
    );
});

bot.catch((err, ctx) => { console.error('[' + BOT_NAME + ':Error]', err.message); });
process.on('unhandledRejection', (r) => { console.error('[' + BOT_NAME + ':UnhandledRejection]', r); });
process.on('uncaughtException', (e) => { console.error('[' + BOT_NAME + ':UncaughtException]', e.message); });

bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(() => bot.launch()).then(() => {
    console.log('[' + BOT_NAME + '] ✅ Bot clone berjalan!');
}).catch(err => {
    console.error('[' + BOT_NAME + '] ❌ Gagal launch:', err.message);
    process.exit(1);
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
`;
}

async function launchCloneBot(botName, botToken, ownerId) {
    if (activeCloneProcesses.has(botName)) throw new Error(`Clone ${botName} sudah berjalan!`);
    const cloneDir = path.join(DATA_ROOT, 'clones', botName);
    fs.ensureDirSync(cloneDir);
    const scriptPath = path.join(cloneDir, 'bot.js');

    // Tulis ulang script clone ke file
    const scriptContent = generateCloneScript(botToken, botName, ownerId, DATA_ROOT);
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');

    // Install dependencies di folder clone jika belum ada
    const cloneNodeModules = path.join(cloneDir, 'node_modules');
    if (!fs.existsSync(cloneNodeModules)) {
        const pkgJson = path.join(cloneDir, 'package.json');
        if (!fs.existsSync(pkgJson)) {
            fs.writeJsonSync(pkgJson, { name: botName, version: '1.0.0', dependencies: { telegraf: '*', 'fs-extra': '*', uuid: '*', 'node-cron': '*' } });
        }
        console.log(`[${botName}] Installing dependencies...`);
        try {
            require('child_process').execSync('npm install --prefer-offline', { cwd: cloneDir, stdio: 'inherit', timeout: 60000 });
        } catch(e) {
            // Fallback: pakai node_modules dari parent
            console.log(`[${botName}] npm install gagal, pakai modules dari parent`);
        }
    }

    // Gunakan spawn dengan node (lebih reliable dari fork)
    const proc = spawn(process.execPath, [scriptPath], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd: cloneDir
    });

    if (!proc || !proc.pid) throw new Error(`Gagal membuat process untuk clone ${botName}`);

    activeCloneProcesses.set(botName, proc);

    proc.stdout?.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.log(`[${botName}] ${msg}`);
    });
    proc.stderr?.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.error(`[${botName}:ERR] ${msg}`);
    });
    proc.on('exit', (code, signal) => {
        activeCloneProcesses.delete(botName);
        const errMsg = (code && code !== 0) ? `Exit code ${code}` : (signal ? `Signal ${signal}` : null);
        db.update(DB.clones, c => c.botName === botName, c => {
            c.aktif = false;
            c.error = errMsg;
            c.stoppedAt = new Date().toISOString();
        });
        console.log(`[${botName}] Process berhenti (code: ${code}, signal: ${signal})`);
    });
    proc.on('error', (err) => {
        console.error(`[${botName}] Process error:`, err.message);
        activeCloneProcesses.delete(botName);
        db.update(DB.clones, c => c.botName === botName, c => { c.aktif = false; c.error = err.message; });
    });

    // Tandai clone sebagai aktif di DB
    db.update(DB.clones, c => c.botName === botName, c => {
        c.aktif = true;
        c.error = null;
        c.startedAt = new Date().toISOString();
    });

    // Tunggu 3 detik — jika langsung crash, lempar error
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(proc), 3000);
        proc.once('exit', (code) => {
            clearTimeout(timer);
            if (code && code !== 0) {
                reject(new Error(`Clone "${botName}" crash saat startup (exit code: ${code}). Periksa token bot!`));
            } else {
                resolve(proc);
            }
        });
    });

    return proc;
}

async function stopCloneBot(botName) {
    const proc = activeCloneProcesses.get(botName);
    if (!proc) return false;
    proc.kill('SIGTERM');
    activeCloneProcesses.delete(botName);
    return true;
}

// ==================== CLONE CALLBACKS ====================
bot.action('owner_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const clones  = db.read(DB.clones);
    const aktif   = [...activeCloneProcesses.keys()].length;
    const expired = clones.filter(c => isCloneExpired(c.botName)).length;
    const msg = `🤖 *MANAJEMEN CLONE BOT*\n\n` +
        `🟢 Aktif: *${aktif}* | 🔴 Mati: *${clones.length - aktif}* | ⏰ Expired: *${expired}*\n` +
        `📦 Total Clone: *${clones.length}*`;
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: [
        [{ text: '📋 List Clone',        callback_data: 'owner_list_clone' }],
        [{ text: '▶️ Start All',         callback_data: 'owner_start_all' },
         { text: '⏹️ Stop All',          callback_data: 'owner_stop_all' }],
        [{ text: '🔄 Update All Clone',  callback_data: 'owner_update_all_clone' }],
        [{ text: '📖 Panduan Clone',     callback_data: 'owner_guide_clone' }],
        [{ text: '🔙 Owner Panel',       callback_data: 'owner_panel' }]
    ]}});
});

bot.action('owner_list_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const clones = db.read(DB.clones);
    let msg = `🤖 *DAFTAR CLONE BOT*\n\nTotal: ${clones.length}\n\n`;
    if (!clones.length) msg += 'Belum ada clone.\nGunakan /clone\_bot untuk membuat.';
    else clones.forEach(c => {
        const running    = activeCloneProcesses.has(c.botName);
        const sub        = db.find(DB.clone_subscriptions, s => s.botName === c.botName);
        const expired    = isCloneExpired(c.botName);
        const sisa       = sisaHariClone(c.botName);
        const statusIcon = expired ? '⏰' : running ? '🟢' : '🔴';
        const sisaInfo   = sub ? (expired ? `\n  ⏰ *EXPIRED*` : `\n  ⏳ Sisa: *${sisa} hari*`) : '\n  ♾️ Tanpa batas';
        msg += `${statusIcon} *${c.botName}* (@${c.username || '-'})${sisaInfo}${c.error ? `\n  ⚠️ ${c.error}` : ''}\n`;
    });
    const rows = [];
    clones.forEach(c => {
        const running = activeCloneProcesses.has(c.botName);
        rows.push([
            { text: `${running ? '⏹' : '▶️'} ${c.botName}`, callback_data: running ? `clone_stop_${c.botName}` : `clone_start_${c.botName}` },
            { text: `🗑 Hapus`, callback_data: `clone_delete_confirm_${c.botName}` }
        ]);
    });
    rows.push([{ text: '▶️ Start All', callback_data: 'owner_start_all' }, { text: '⏹️ Stop All', callback_data: 'owner_stop_all' }]);
    rows.push([{ text: '🔄 Refresh',   callback_data: 'owner_list_clone' }]);
    rows.push([{ text: '🔙 Clone Menu',callback_data: 'owner_clone' }]);
    await safeEditMessage(ctx, msg, { reply_markup: { inline_keyboard: rows }});
});

bot.action('owner_start_all', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx, '🔄 Memulai semua clone...');
    const clones = db.read(DB.clones).filter(c => !activeCloneProcesses.has(c.botName) && !isCloneExpired(c.botName));
    if (!clones.length) return ctx.reply('⚠️ Tidak ada clone yang perlu dijalankan.');
    let ok = 0, fail = 0;
    for (const clone of clones) {
        try { await launchCloneBot(clone.botName, clone.botToken, clone.ownerId); ok++; } catch(e) { fail++; }
        await new Promise(r => setTimeout(r, 1500));
    }
    ctx.reply(`✅ Start All selesai!\n🟢 Berhasil: ${ok}\n❌ Gagal: ${fail}`);
});

bot.action('owner_stop_all', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx, '🛑 Menghentikan semua clone...');
    const running = [...activeCloneProcesses.keys()];
    if (!running.length) return ctx.reply('⚠️ Tidak ada clone yang berjalan.');
    for (const name of running) { await stopCloneBot(name); db.update(DB.clones, c => c.botName === name, c => { c.aktif = false; }); }
    ctx.reply(`🔴 Semua clone dihentikan (${running.length} bot).`);
});


// ==================== CLONE EXTRA BUTTONS ====================

bot.action('owner_update_all_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx, '🔄 Mengupdate semua clone...');
    const clones = db.read(DB.clones);
    if (!clones.length) return ctx.reply('❌ Belum ada clone.');
    let ok = 0, fail = 0, failList = [];
    for (const clone of clones) {
        const result = await updateCloneScript(clone.botName);
        if (!result.ok) { fail++; failList.push(clone.botName); continue; }
        if (activeCloneProcesses.has(clone.botName)) {
            try { activeCloneProcesses.get(clone.botName)?.kill('SIGTERM'); activeCloneProcesses.delete(clone.botName); } catch(e) {}
            await new Promise(r => setTimeout(r, 800));
        }
        try { await launchCloneBot(clone.botName, clone.botToken, clone.ownerId); ok++; } catch(e) { fail++; failList.push(clone.botName + '(restart)'); }
        await new Promise(r => setTimeout(r, 600));
    }
    ctx.reply(
        `✅ *Update All Clone Selesai!*\n\n🟢 Berhasil: ${ok}\n❌ Gagal: ${fail}${failList.length ? '\n• ' + failList.join('\n• ') : ''}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 List Clone', callback_data: 'owner_list_clone' }]] }}
    );
});

bot.action('owner_guide_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '\u274c Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    const guide =
        '\ud83d\udcd6 *PANDUAN CLONE BOT*\n' + '\u2500'.repeat(25) + '\n\n' +
        '*APA ITU CLONE?*\n' +
        'Clone adalah bot terpisah dengan token sendiri yang berjalan di server yang sama.\n\n' +
        '*CARA BUAT CLONE:*\n' +
        '1. Buat bot baru di @BotFather\n' +
        '2. Copy tokennya\n' +
        '3. Kirim: `/clone_bot [token] [nama] [hari]`\n' +
        'Contoh: `/clone_bot 123456:ABC MyShop 30`\n\n' +
        '*PERINTAH CLONE:*\n' +
        '\u25b6\ufe0f `/start_clone [nama]` \u2014 Jalankan\n' +
        '\u23f9\ufe0f `/stop_clone [nama]` \u2014 Hentikan\n' +
        '\ud83d\uddd1 `/delete_clone [nama]` \u2014 Hapus permanen\n' +
        '\u23f3 `/perpanjang_clone [nama] [hari]` \u2014 Perpanjang\n' +
        '\ud83d\udd04 `/update_clone [nama]` \u2014 Update script\n' +
        '\ud83d\udd04 `/update_all_clones` \u2014 Update semua\n\n' +
        '*STATUS CLONE:*\n' +
        '\ud83d\udfe2 = Sedang berjalan\n' +
        '\ud83d\udd34 = Mati / belum distart\n' +
        '\u23f0 = Masa aktif habis\n' +
        '\u267e\ufe0f = Tanpa batas waktu\n\n' +
        '*TIPS:*\n' +
        '\u2022 Clone bot otomatis restart jika crash\n' +
        '\u2022 Data produk clone terpisah dari bot utama\n' +
        '\u2022 Set AI key clone: `/set_ai_key [key]`';
    await ctx.reply(guide, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '\ud83e\udd16 Clone Menu', callback_data: 'owner_clone' }],
        [{ text: '\ud83d\udd19 Owner Panel', callback_data: 'owner_panel' }]
    ]}});
});

bot.action(/^clone_start_(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    const botName = ctx.match[1];
    await safeAnswerCbQuery(ctx, `▶️ Menjalankan ${botName}...`);
    if (isCloneExpired(botName)) return ctx.reply(`❌ Clone *${botName}* sudah expired!\nGunakan /perpanjang\_clone ${botName} [hari]`, { parse_mode: 'Markdown' });
    try {
        const clone = db.find(DB.clones, c => c.botName === botName);
        if (!clone) return ctx.reply(`❌ Clone *${botName}* tidak ditemukan.`, { parse_mode: 'Markdown' });
        await launchCloneBot(botName, clone.botToken, clone.ownerId);
        ctx.reply(`✅ Clone *${botName}* berhasil dijalankan!`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 List Clone', callback_data: 'owner_list_clone' }]] }});
    } catch(e) {
        ctx.reply(`❌ Gagal menjalankan *${botName}*:\n${e.message}`, { parse_mode: 'Markdown' });
    }
});

bot.action(/^clone_stop_(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    const botName = ctx.match[1];
    await safeAnswerCbQuery(ctx, `⏹️ Menghentikan ${botName}...`);
    if (!activeCloneProcesses.has(botName)) return safeAnswerCbQuery(ctx, `⚠️ ${botName} tidak sedang berjalan.`, true);
    await stopCloneBot(botName);
    db.update(DB.clones, c => c.botName === botName, c => { c.aktif = false; });
    ctx.reply(`🔴 Clone *${botName}* dihentikan.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 List Clone', callback_data: 'owner_list_clone' }]] }});
});

bot.action(/^clone_delete_confirm_(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    const botName = ctx.match[1];
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        `⚠️ *HAPUS CLONE*

Aksi ini akan menghapus clone *${botName}* secara permanen termasuk semua datanya.

Yakin?`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '✅ Ya, Hapus!', callback_data: `clone_delete_ok_${botName}` }],
            [{ text: '❌ Batal',      callback_data: 'owner_list_clone' }]
        ]}}
    );
});

bot.action(/^clone_delete_ok_(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    const botName = ctx.match[1];
    await safeAnswerCbQuery(ctx, `🗑 Menghapus ${botName}...`);
    if (activeCloneProcesses.has(botName)) {
        await stopCloneBot(botName);
    }
    db.remove(DB.clones, c => c.botName === botName);
    db.remove(DB.clone_subscriptions, s => s.botName === botName);
    try { fs.removeSync(path.join(DATA_ROOT, 'clones', botName)); } catch(e) {}
    ctx.reply(`✅ Clone *${botName}* berhasil dihapus.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 List Clone', callback_data: 'owner_list_clone' }]] }});
});

// ==================== GRUP CALLBACK HANDLERS ====================
bot.action(/^grp_tag_admin_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = parseInt(ctx.match[1]);
    try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        let msg = `📢 *TAG ADMIN*\n\n`;
        admins.filter(a => !a.user.is_bot).forEach(a => {
            msg += a.user.username ? `@${a.user.username} ` : `[${a.user.first_name}](tg://user?id=${a.user.id}) `;
        });
        await bot.telegram.sendMessage(chatId, msg + GRUP_WATERMARK, { parse_mode: 'Markdown' });
        await ctx.reply('✅ Admin di-tag!');
    } catch(e) { await ctx.reply('❌ Gagal: ' + e.message); }
});

bot.action(/^grp_announce_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = ctx.match[1];
    ctx.session.action = `group_announce_${chatId}`;
    await ctx.reply('📢 Kirim pesan pengumuman yang ingin dikirim ke grup:');
});

bot.action(/^grp_setwelcome_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = ctx.match[1];
    ctx.session.action = `setwelcome_${chatId}`;
    await ctx.reply('👋 Kirim teks welcome baru:\nVariabel: {name}, {username}, {mention}');
});

bot.action(/^grp_rules_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = String(ctx.match[1]);
    const rules = db.find(DB.group_rules, r => r.chatId === chatId);
    if (!rules?.text) return ctx.reply('Belum ada rules. Set dengan /setrules di dalam grup.');
    ctx.reply(`📜 *RULES:*\n\n${rules.text}`, { parse_mode: 'Markdown' });
});

bot.action(/^grp_mute_menu_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    ctx.reply('Untuk mute member, gunakan /mute di dalam grup dengan cara reply ke pesan member.\nFormat: /mute [1h|6h|12h|24h]');
});

bot.action(/^grp_kick_menu_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    ctx.reply('Untuk kick member, gunakan /kick di dalam grup dengan cara reply ke pesan member.\nFormat: /kick [alasan]');
});

bot.action(/^grp_warn_menu_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    ctx.reply('Untuk warn member, gunakan /warn di dalam grup dengan cara reply ke pesan member.\nFormat: /warn [alasan]');
});

bot.action(/^grp_antilink_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = String(ctx.match[1]);
    const gs = db.find(DB.groups, g => String(g.chatId) === String(chatId)) || {};
    const newVal = !gs.antilink;
    db.upsert(DB.groups, g => String(g.chatId) === String(chatId), { chatId, ...gs, antilink: newVal, updatedAt: new Date().toISOString() });
    ctx.reply(`🔗 Anti-Link *${newVal ? 'AKTIF ✅' : 'NONAKTIF ❌'}*!`, { parse_mode: 'Markdown' });
});

bot.action(/^grp_antikasar_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = String(ctx.match[1]);
    const gs = db.find(DB.groups, g => String(g.chatId) === String(chatId)) || {};
    const newVal = !gs.antikasar;
    db.upsert(DB.groups, g => String(g.chatId) === String(chatId), { chatId, ...gs, antikasar: newVal, updatedAt: new Date().toISOString() });
    ctx.reply(`🤐 Anti-Kata Kasar *${newVal ? 'AKTIF ✅' : 'NONAKTIF ❌'}*!`, { parse_mode: 'Markdown' });
});

bot.action(/^grp_list_produk_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const categories = db.filter(DB.categories, c => c.aktif);
    if (!categories.length) return ctx.reply('❌ Belum ada produk tersedia.');
    let msg = `🛍️ *PRODUK TERSEDIA:*\n\n`;
    for (const cat of categories) {
        const products = db.filter(DB.products, p => p.kategori === cat.id && p.aktif !== false);
        if (!products.length) continue;
        msg += `${cat.icon || '📦'} *${cat.nama}*\n`;
        for (const p of products) {
            const plans = db.filter(DB.plans, pl => pl.produk_id === p.id && pl.aktif !== false);
            plans.forEach(pl => { msg += `  • ${pl.nama} — *${formatRp(pl.harga)}*\n`; });
        }
        msg += '\n';
    }
    msg += `\n📱 Order via DM bot!`;
    await ctx.reply(msg + GRUP_WATERMARK, { parse_mode: 'Markdown' });
});

// AI toggle dari panel grup
bot.action(/^grp_ai_toggle_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner/Admin bot yang bisa mengatur AI!');
    if (!config.aiGroupEnabled && !config.aiKey) {
        return ctx.reply('❌ Set AI key dulu!\nKirim: `/set_ai_key [api_key]`\nDapat key gratis di: https://console.mistral.ai', { parse_mode: 'Markdown' });
    }
    config.aiGroupEnabled = !config.aiGroupEnabled;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    const chatId = ctx.match[1];
    ctx.reply(`🤖 AI Grup *${config.aiGroupEnabled ? 'AKTIF ✅' : 'NONAKTIF ❌'}*!\n\n_Untuk set prompt: /set\_ai\_prompt [prompt]_`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⚙️ Kelola Grup', callback_data: `grp_manage_back_${chatId}` }]] }
    });
});

// Status grup
bot.action(/^grp_status_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = String(ctx.match[1]);
    const gs = db.find(DB.groups, g => String(g.chatId) === chatId) || {};
    const msg = `📊 *STATUS GRUP*\n\n` +
        `🔗 Anti-Link: ${gs.antilink ? '✅ Aktif' : '❌ Nonaktif'}\n` +
        `🤐 Anti-Kasar: ${gs.antikasar ? '✅ Aktif' : '❌ Nonaktif'}\n` +
        `🤖 AI Grup: ${config.aiGroupEnabled ? '✅ Aktif' : '❌ Nonaktif'}\n` +
        `🔑 AI Key: ${config.aiKey ? '✅ Ada' : '❌ Belum diset'}\n` +
        `\n_Ketik /manage untuk kelola_`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action(/^grp_manage_back_(-?\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const chatId = ctx.match[1];
    await ctx.reply('⚙️ *KELOLA GRUP*', {
        parse_mode: 'Markdown',
        reply_markup: buildGroupManageKeyboard(chatId)
    });
});

// ==================== GRUP COMMANDS ====================

bot.command('setwelcome', async (ctx) => {
    if (!isGroup(ctx)) return ctx.reply('Perintah ini hanya untuk grup.');
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) {
        ctx.session.action = `setwelcome_${ctx.chat.id}`;
        return ctx.reply('👋 Kirim teks welcome baru:\nVariabel: {name} {username} {mention}');
    }
    const chatId = String(ctx.chat.id);
    db.upsert(DB.group_welcome, w => String(w.chatId) === String(chatId), { chatId, text, updatedAt: new Date().toISOString() });
    ctx.reply('✅ Pesan welcome disimpan!\nVariabel: {name}, {username}, {mention}');
});

bot.command('rules', async (ctx) => {
    if (!isGroup(ctx)) return;
    const chatId = String(ctx.chat.id);
    const rules = db.find(DB.group_rules, r => r.chatId === chatId);
    if (!rules?.text) return ctx.reply('📜 Belum ada rules di grup ini.\nAdmin bisa set rules dengan /setrules [teks]');
    ctx.reply(`📜 *RULES GRUP*\n\n${rules.text}${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
});

bot.command('setrules', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) {
        ctx.session.action = `setrules_${ctx.chat.id}`;
        return ctx.reply('📜 Kirim teks rules baru:');
    }
    const chatId = String(ctx.chat.id);
    db.upsert(DB.group_rules, r => r.chatId === chatId, { chatId, text, updatedAt: new Date().toISOString() });
    ctx.reply('✅ Rules disimpan!');
});

bot.command('warn', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('Format: Reply ke pesan user lalu ketik /warn [alasan]');
    const target = reply.from;
    if (target.is_bot) return ctx.reply('❌ Tidak bisa warn bot.');
    const chatId = String(ctx.chat.id);
    const alasan = ctx.message.text.split(' ').slice(1).join(' ') || 'Melanggar rules';
    const key = `${chatId}_${target.id}`;
    let warnData = db.find(DB.group_warns, w => w.key === key);
    if (!warnData) {
        warnData = { key, chatId, userId: target.id, username: target.username, warns: [] };
        db.push(DB.group_warns, warnData);
    }
    warnData.warns.push({ alasan, by: ctx.from.id, at: new Date().toISOString() });
    db.update(DB.group_warns, w => w.key === key, w => { w.warns = warnData.warns; });
    const count = warnData.warns.length;
    const mention = await getMention(target);
    if (count >= 3) {
        try { await ctx.telegram.banChatMember(ctx.chat.id, target.id); await ctx.telegram.unbanChatMember(ctx.chat.id, target.id); } catch(e) {}
        db.update(DB.group_warns, w => w.key === key, w => { w.warns = []; });
        return ctx.reply(`🚫 ${mention} *dikick* karena sudah mendapat 3 peringatan!\nAlasan: ${alasan}`, { parse_mode: 'Markdown' });
    }
    ctx.reply(`⚠️ *PERINGATAN ${count}/3*\n\n👤 ${mention}\n📌 Alasan: ${alasan}\n\n_${3 - count} peringatan lagi → dikick otomatis_${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
});

bot.command('mute', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('Format: Reply ke pesan user lalu ketik /mute [1h|6h|12h|24h]');
    const target = reply.from;
    if (target.is_bot) return ctx.reply('❌ Tidak bisa mute bot.');
    const durMap = { '1h': 3600, '6h': 21600, '12h': 43200, '24h': 86400, '1d': 86400 };
    const durStr = ctx.message.text.split(' ')[1] || '1h';
    const durSec = durMap[durStr] || 3600;
    const until  = Math.floor(Date.now() / 1000) + durSec;
    try {
        await ctx.telegram.restrictChatMember(ctx.chat.id, target.id, {
            permissions: { can_send_messages: false, can_send_media_messages: false, can_send_polls: false, can_send_other_messages: false },
            until_date: until
        });
        const mention = await getMention(target);
        ctx.reply(`🔇 ${mention} di-mute selama *${durStr}*${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
    } catch(e) { ctx.reply(`❌ Gagal mute: ${e.message}`); }
});

bot.command('unmute', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('Format: Reply ke pesan user lalu ketik /unmute');
    const target = reply.from;
    try {
        await ctx.telegram.restrictChatMember(ctx.chat.id, target.id, {
            permissions: { can_send_messages: true, can_send_media_messages: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true }
        });
        const mention = await getMention(target);
        ctx.reply(`🔊 ${mention} di-unmute!${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
    } catch(e) { ctx.reply(`❌ Gagal unmute: ${e.message}`); }
});

bot.command('kick', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('Format: Reply ke pesan user lalu ketik /kick [alasan]');
    const target = reply.from;
    if (target.is_bot) return ctx.reply('❌ Tidak bisa kick bot.');
    const alasan = ctx.message.text.split(' ').slice(1).join(' ') || 'Tidak ada alasan';
    try {
        await ctx.telegram.banChatMember(ctx.chat.id, target.id);
        await ctx.telegram.unbanChatMember(ctx.chat.id, target.id);
        const mention = await getMention(target);
        ctx.reply(`🚫 ${mention} dikick!\n📌 Alasan: ${alasan}${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
    } catch(e) { ctx.reply(`❌ Gagal kick: ${e.message}`); }
});

bot.command('tagadmin', async (ctx) => {
    if (!isGroup(ctx)) return;
    const admins = await getGroupAdmins(ctx.chat.id);
    if (!admins.length) return ctx.reply('❌ Tidak bisa mengambil daftar admin.');
    let msg = `📢 *TAG ADMIN GRUP*\n\n`;
    for (const a of admins) {
        const u = a.user;
        msg += u.username ? `@${u.username} ` : `[${u.first_name}](tg://user?id=${u.id}) `;
    }
    ctx.reply(msg + GRUP_WATERMARK, { parse_mode: 'Markdown' });
});

bot.command('announce', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    let text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text && ctx.message.reply_to_message?.text) text = ctx.message.reply_to_message.text;
    if (!text) return ctx.reply('Format: /announce [pesan] atau reply ke pesan + /announce');
    ctx.reply(`📢 *PENGUMUMAN*\n\n${text}${GRUP_WATERMARK}`, { parse_mode: 'Markdown' });
});

bot.command('del', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    if (!ctx.message.reply_to_message) return ctx.reply('Reply ke pesan yang ingin dihapus lalu ketik /del');
    try {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.reply_to_message.message_id);
        try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch(e) {}
    } catch(e) { ctx.reply('❌ Gagal hapus pesan. Pastikan bot punya izin delete message.'); }
});

bot.command('antilink', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (!['on', 'off'].includes(arg)) return ctx.reply('Format: /antilink on atau /antilink off');
    const chatId = String(ctx.chat.id);
    const gs = db.find(DB.groups, g => String(g.chatId) === String(chatId)) || {};
    db.upsert(DB.groups, g => String(g.chatId) === String(chatId), { ...gs, chatId, antilink: arg === 'on', updatedAt: new Date().toISOString() });
    ctx.reply(`🔗 Anti-Link *${arg === 'on' ? 'AKTIF ✅' : 'NONAKTIF ❌'}*!`, { parse_mode: 'Markdown' });
});

bot.command('antikasar', async (ctx) => {
    if (!isGroup(ctx)) return;
    const isGA = await isGroupAdmin(ctx);
    if (!isGA && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Hanya admin grup!');
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (!['on', 'off'].includes(arg)) return ctx.reply('Format: /antikasar on atau /antikasar off');
    const chatId = String(ctx.chat.id);
    const gs = db.find(DB.groups, g => String(g.chatId) === String(chatId)) || {};
    db.upsert(DB.groups, g => String(g.chatId) === String(chatId), { ...gs, chatId, antikasar: arg === 'on', updatedAt: new Date().toISOString() });
    ctx.reply(`🤐 Anti-Kata Kasar *${arg === 'on' ? 'AKTIF ✅' : 'NONAKTIF ❌'}*!`, { parse_mode: 'Markdown' });
});

// ==================== ADMIN COMMANDS ====================

bot.command('pay', async (ctx) => {
    if (isGroup(ctx)) return replyCaraBayar(ctx, ctx.message.message_id);
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) return ctx.reply('❌ Belum ada metode pembayaran.\nHubungi admin.');
    let msg = `💳 *METODE PEMBAYARAN*\n${'─'.repeat(25)}\n\n`;
    const buttons = [];
    for (const q of qrisList) {
        msg += `💳 *${q.nama}*\n`;
        if (q.nomor)     msg += `📋 No: \`${q.nomor}\`\n`;
        if (q.atas_nama) msg += `👤 A/N: ${q.atas_nama}\n`;
        msg += '\n';
        if (q.qrisImage) buttons.push([{ text: `🖼️ QR ${q.nama}`, callback_data: `show_qr_${q.kode}` }]);
    }
    buttons.push([{ text: '🛍️ Belanja', callback_data: 'belanja' }, { text: '🔙 Menu', callback_data: 'back_to_menu' }]);
    await ctx.reply(msg + WATERMARK, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
});

bot.command('hapus_kategori', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Format: /hapus_kategori [id]\n\nKirim /list_kategori untuk melihat ID kategori.');
    const kat = db.find(DB.categories, c => c.id === id);
    if (!kat) return ctx.reply('❌ Kategori tidak ditemukan.\n\nKirim /list_kategori untuk melihat daftar.');
    const products = db.filter(DB.products, p => p.kategori === id);
    const prodIds = products.map(p => p.id);
    const plans = db.filter(DB.plans, pl => prodIds.includes(pl.produk_id));
    const planIds = plans.map(pl => pl.id);
    db.remove(DB.akun_stok, a => planIds.includes(a.planId));
    db.remove(DB.plans, pl => prodIds.includes(pl.produk_id));
    db.remove(DB.products, p => p.kategori === id);
    db.remove(DB.categories, c => c.id === id);
    ctx.reply('✅ Kategori *' + kat.nama + '* dihapus!\n🗑️ Termasuk ' + products.length + ' produk, ' + plans.length + ' plan & stok akun terkait.', { parse_mode: 'Markdown' });
});

bot.command('hapus_produk', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Format: /hapus_produk [id]\n\nKirim /list_produk untuk melihat ID produk.');
    const produk = db.find(DB.products, p => p.id === id);
    if (!produk) return ctx.reply('❌ Produk tidak ditemukan.\n\nKirim /list_produk untuk melihat daftar.');
    const plans = db.filter(DB.plans, p => p.produk_id === id);
    for (const plan of plans) { db.remove(DB.akun_stok, a => a.planId === plan.id); }
    db.remove(DB.plans, p => p.produk_id === id);
    db.remove(DB.products, p => p.id === id);
    ctx.reply('✅ Produk *' + produk.nama + '* dihapus beserta ' + plans.length + ' paket & stok akunnya.', { parse_mode: 'Markdown' });
});

bot.command('hapus_plan', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Format: /hapus_plan [plan_id]\n\nKirim /list_produk untuk melihat Plan ID.');
    const plan = db.find(DB.plans, p => p.id === id);
    if (!plan) return ctx.reply('❌ Plan tidak ditemukan.\n\nKirim /list_produk untuk melihat daftar.');
    db.remove(DB.akun_stok, a => a.planId === id);
    db.remove(DB.plans, p => p.id === id);
    ctx.reply('✅ Plan *' + plan.nama + '* dihapus beserta stok akunnya.', { parse_mode: 'Markdown' });
});



bot.command('ubah_harga', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        const plans = db.read(DB.plans);
        if (!plans.length) return ctx.reply('❌ Belum ada plan/paket.');
        const products = db.read(DB.products);
        let msg = '💰 *DAFTAR PLAN & HARGA*\n\nFormat: /ubah_harga [plan_id] [harga_baru]\n\n';
        products.forEach(prod => {
            const prodPlans = plans.filter(p => p.produk_id === prod.id);
            if (!prodPlans.length) return;
            msg += '\u{1F4E6} *' + prod.nama + '*\n';
            prodPlans.forEach(p => {
                msg += '  - ' + p.id + ' | ' + p.nama + ' | *' + formatRp(p.harga) + '*\n';
            });
            msg += '\n';
        });
        return ctx.reply(msg, { parse_mode: 'Markdown' });
    }
    const planId = args[0];
    const hargaBaru = parseInt(args[1].replace(/\D/g, ''));
    if (isNaN(hargaBaru) || hargaBaru <= 0) return ctx.reply('❌ Harga tidak valid!\nContoh: /ubah_harga abc123 25000');
    const plan = db.find(DB.plans, p => p.id === planId);
    if (!plan) return ctx.reply('❌ Plan tidak ditemukan.\n\nKirim /ubah_harga untuk lihat daftar plan.');
    const hargaLama = plan.harga;
    db.update(DB.plans, p => p.id === planId, p => { p.harga = hargaBaru; });
    ctx.reply('✅ *Harga berhasil diubah!*\n\nPlan: *' + plan.nama + '*\nHarga lama: ' + formatRp(hargaLama) + '\nHarga baru: *' + formatRp(hargaBaru) + '*', { parse_mode: 'Markdown' });
});
bot.command('tambah_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Format: /tambah_qris [kode] [nama] [nomor]\nContoh: /tambah_qris bca BCA 1234567890');
    const [kode, nama, nomor] = args;
    if (db.find(DB.qris, q => q.kode === kode)) return ctx.reply('❌ Kode QRIS sudah ada!');
    db.push(DB.qris, { kode, nama, nomor: nomor || null, aktif: true, qrisImage: null, createdAt: new Date().toISOString() });
    ctx.reply(`✅ QRIS *${nama}* (${kode}) ditambahkan!\n\nUpload QR dengan:\nReply gambar + /upload\\_qris ${kode}`, { parse_mode: 'Markdown' });
});

bot.command('hapus_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const kode = ctx.message.text.split(' ')[1];
    if (!kode) return ctx.reply('Format: /hapus_qris [kode]');
    const n = db.remove(DB.qris, q => q.kode === kode);
    ctx.reply(n ? `✅ QRIS \`${kode}\` dihapus.` : `❌ QRIS tidak ditemukan.`, { parse_mode: 'Markdown' });
});

bot.command('upload_qris', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const kode = ctx.message.text.split(' ')[1];
    if (!kode) return ctx.reply('Format: Reply gambar + /upload_qris [kode]');
    const qris = db.find(DB.qris, q => q.kode === kode);
    if (!qris) return ctx.reply('❌ QRIS tidak ditemukan!');
    if (!ctx.message.reply_to_message?.photo) return ctx.reply('❌ Reply ke GAMBAR dulu!');
    const photo = ctx.message.reply_to_message.photo;
    const fileId = photo[photo.length - 1].file_id;
    db.update(DB.qris, q => q.kode === kode, q => { q.qrisImage = fileId; });
    await ctx.reply(`✅ QR Code untuk *${qris.nama}* berhasil diupload!`, { parse_mode: 'Markdown' });
    await ctx.replyWithPhoto(fileId, { caption: `🖼️ Preview QR — ${qris.nama}` });
});

bot.command('buat_pengumuman', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    const parts = text.split('|');
    if (parts.length < 2) return ctx.reply('Format: /buat_pengumuman [judul] | [isi]');
    const judul = parts[0].trim();
    const isi = parts.slice(1).join('|').trim();
    const id = genCode('ANN');
    db.push(DB.announcements, { id, judul, isi, aktif: true, createdAt: new Date().toISOString() });
    ctx.reply(`✅ Pengumuman *${judul}* dibuat!\nID: \`${id}\``, { parse_mode: 'Markdown' });
});

bot.command('hapus_pengumuman', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Format: /hapus_pengumuman [id]');
    const n = db.remove(DB.announcements, a => a.id === id);
    ctx.reply(n ? `✅ Pengumuman \`${id}\` dihapus.` : `❌ Pengumuman tidak ditemukan.`, { parse_mode: 'Markdown' });
});

bot.command('tambah_admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return ctx.reply('Format: /tambah_admin [user_id] [nama]');
    const userId = parseInt(args[0]);
    const nama = args.slice(1).join(' ') || 'Admin';
    if (isNaN(userId)) return ctx.reply('❌ user_id harus angka!');
    if (db.find(DB.admins, a => a.id === userId)) return ctx.reply('❌ User sudah jadi admin!');
    db.push(DB.admins, { id: userId, nama, aktif: true, addedAt: new Date().toISOString() });
    ctx.reply(`✅ *${nama}* (\`${userId}\`) ditambahkan sebagai admin!`, { parse_mode: 'Markdown' });
});

bot.command('hapus_admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const userId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(userId)) return ctx.reply('Format: /hapus_admin [user_id]');
    const n = db.remove(DB.admins, a => a.id === userId);
    ctx.reply(n ? `✅ Admin \`${userId}\` dihapus.` : `❌ Admin tidak ditemukan.`, { parse_mode: 'Markdown' });
});

bot.command('blokir', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    const userId = parseInt(args[0]);
    if (isNaN(userId)) return ctx.reply('Format: /blokir [user_id] [alasan]');
    const alasan = args.slice(1).join(' ') || 'Tidak ada alasan';
    db.upsert(DB.blocked_users, b => b.userId === userId, { userId, alasan, blockedAt: new Date().toISOString() });
    ctx.reply(`✅ User \`${userId}\` diblokir.\nAlasan: ${alasan}`, { parse_mode: 'Markdown' });
});

bot.command('unblokir', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const userId = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(userId)) return ctx.reply('Format: /unblokir [user_id]');
    const n = db.remove(DB.blocked_users, b => b.userId === userId);
    ctx.reply(n ? `✅ User \`${userId}\` diunblokir.` : `❌ User tidak ada di daftar blokir.`, { parse_mode: 'Markdown' });
});

bot.command('konfirmasi', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const invoiceId = ctx.message.text.split(' ')[1];
    if (!invoiceId) return ctx.reply('Format: /konfirmasi [invoice_id]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.status === 'completed') return ctx.reply('⚠️ Order sudah dikonfirmasi!');
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'completed'; o.confirmedAt = new Date().toISOString(); o.confirmedBy = ctx.from.id; });
    db.update(DB.customers, c => c.id === order.userId, c => { c.totalBelanja += order.total; c.totalOrder += 1; });
    const ok = await autoDeliveryAkun(ctx, order);
    const allManual = (order.items || []).every(item => isManualProduct(item.planId));
    if (!ok && !allManual) {
        try { await bot.telegram.sendMessage(order.userId, `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n🆔 Invoice: \`${invoiceId}\`\n💰 Total: ${formatRp(order.total)}\n\nAkun akan segera dikirim.${WATERMARK}`, { parse_mode: 'Markdown' }); } catch(e) {}
    }
    let replyMsg = `✅ Order \`${invoiceId}\` dikonfirmasi.`;
    if (allManual) replyMsg += '\n🔧 Produk manual — kirim pesan ke customer via tombol di bawah.';
    else if (ok)   replyMsg += '\n🤖 Akun terkirim otomatis.';
    else           replyMsg += '\n⚠️ Stok habis, kirim manual.';
    ctx.reply(replyMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '💬 Kirim Pesan ke Customer', callback_data: `kirim_manual_${invoiceId}` }],
        [{ text: '⏳ Order Pending',            callback_data: 'admin_orders_pending' }]
    ]}});
});

bot.command('batal_order', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    const invoiceId = args[0];
    if (!invoiceId) return ctx.reply('Format: /batal_order [invoice_id] [alasan]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    const alasan = args.slice(1).join(' ') || 'Dibatalkan admin';
    db.update(DB.orders, o => o.id === invoiceId, o => { o.status = 'cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = alasan; });
    try { await bot.telegram.sendMessage(order.userId, `❌ *ORDER DIBATALKAN*\n\n🆔 \`${invoiceId}\`\nAlasan: ${alasan}`, { parse_mode: 'Markdown' }); } catch(e) {}
    ctx.reply(`✅ Order \`${invoiceId}\` dibatalkan.`, { parse_mode: 'Markdown' });
});

bot.command('kirim_akun', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Format: /kirim_akun [user_id] [akun/data]');
    const userId = parseInt(args[0]);
    const data = args.slice(1).join(' ');
    if (isNaN(userId)) return ctx.reply('❌ user_id harus angka!');
    try {
        await bot.telegram.sendMessage(userId, `📦 *AKUN DARI ADMIN*\n\n\`\`\`\n${data}\n\`\`\`\n\n🔒 _Jangan bagikan ke siapapun!_${WATERMARK}`, { parse_mode: 'Markdown' });
        ctx.reply(`✅ Akun berhasil dikirim ke user \`${userId}\``, { parse_mode: 'Markdown' });
    } catch(e) {
        ctx.reply(`❌ Gagal kirim ke user \`${userId}\`: ${e.message}`, { parse_mode: 'Markdown' });
    }
});

bot.command('cekorder', async (ctx) => {
    const invoiceId = ctx.message.text.split(' ')[1];
    if (!invoiceId) return ctx.reply('Format: /cekorder [invoice_id]');
    const order = db.find(DB.orders, o => o.id === invoiceId);
    if (!order) return ctx.reply('❌ Order tidak ditemukan!');
    if (order.userId !== ctx.from.id && !isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Bukan order Anda!');
    const statusMap = { pending:'⏳ Menunggu', waiting_payment:'💳 Menunggu Pembayaran', paid:'✅ Dibayar', cancelled:'❌ Dibatalkan', completed:'🎉 Selesai' };
    ctx.reply(
        `🧾 *STATUS ORDER*\n\n🆔 \`${order.id}\`\n📊 *${statusMap[order.status] || order.status}*\n💰 ${formatRp(order.total)}\n📅 ${formatDate(order.createdAt)}`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('set_nama', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const nama = ctx.message.text.split(' ').slice(1).join(' ');
    if (!nama) return ctx.reply('Format: /set_nama [nama baru]');
    config.name = nama;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply(`✅ Nama bot diubah ke *${nama}*`, { parse_mode: 'Markdown' });
});

bot.command('maintenance', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (!['on', 'off'].includes(arg)) return ctx.reply('Format: /maintenance on atau /maintenance off');
    config.maintenance = arg === 'on';
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply(`🔧 Maintenance *${config.maintenance ? 'AKTIF 🔴' : 'NONAKTIF 🟢'}*!`, { parse_mode: 'Markdown' });
});

// ==================== CLONE COMMANDS ====================
bot.command('clone_bot', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('Format: /clone_bot [token] [nama] [hari]\nContoh: /clone_bot 123:ABC MyShop 30');
    const botToken = args[1], botName = args[2], hari = parseInt(args[3]) || 0;
    if (db.find(DB.clones, c => c.botName === botName)) return ctx.reply(`❌ Clone "${botName}" sudah ada!`);
    let username = '-';
    try {
        const info = await ctx.telegram.callApi('getMe', {}, { token: botToken });
        username = info.username || '-';
    } catch(e) { return ctx.reply(`❌ Token tidak valid: ${e.message}`); }
    db.push(DB.clones, { botName, botToken, username, ownerId: config.ownerId, aktif: false, createdAt: new Date().toISOString() });
    if (hari > 0) {
        const expiredAt = new Date(Date.now() + hari * 86400000).toISOString();
        db.upsert(DB.clone_subscriptions, s => s.botName === botName, { botName, expiredAt, createdAt: new Date().toISOString() });
    }
    await ctx.reply(`✅ *Clone "${botName}" dibuat!*\n🤖 @${username}\n⏳ Masa aktif: ${hari > 0 ? `${hari} hari` : 'Tanpa batas'}\n\nMenjalankan bot...`, { parse_mode: 'Markdown' });
    try { await launchCloneBot(botName, botToken, config.ownerId); await ctx.reply(`🟢 Clone "${botName}" berhasil dijalankan!`); }
    catch(e) { await ctx.reply(`⚠️ Clone dibuat tapi gagal dijalankan: ${e.message}`); }
});

bot.command('start_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const botName = ctx.message.text.split(' ')[1];
    if (!botName) return ctx.reply('Format: /start_clone [nama]');
    const clone = db.find(DB.clones, c => c.botName === botName);
    if (!clone) return ctx.reply(`❌ Clone "${botName}" tidak ditemukan!`);
    if (isCloneExpired(botName)) return ctx.reply(`⏰ Clone "${botName}" expired! Gunakan /perpanjang_clone`);
    if (activeCloneProcesses.has(botName)) return ctx.reply(`⚠️ Clone "${botName}" sudah berjalan!`);
    try { await launchCloneBot(botName, clone.botToken, clone.ownerId); ctx.reply(`🟢 Clone "${botName}" dijalankan!`); }
    catch(e) { ctx.reply(`❌ Gagal: ${e.message}`); }
});

bot.command('stop_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const botName = ctx.message.text.split(' ')[1];
    if (!botName) return ctx.reply('Format: /stop_clone [nama]');
    const ok = await stopCloneBot(botName);
    if (ok) { db.update(DB.clones, c => c.botName === botName, c => { c.aktif = false; }); ctx.reply(`🔴 Clone "${botName}" dihentikan!`); }
    else ctx.reply(`⚠️ Clone "${botName}" tidak sedang berjalan.`);
});

bot.command('delete_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const botName = ctx.message.text.split(' ')[1];
    if (!botName) return ctx.reply('Format: /delete_clone [nama]');
    await stopCloneBot(botName);
    db.remove(DB.clones, c => c.botName === botName);
    db.remove(DB.clone_subscriptions, s => s.botName === botName);
    const cloneDir = path.join(DATA_ROOT, 'clones', botName);
    try { fs.removeSync(cloneDir); } catch(e) {}
    ctx.reply(`🗑️ Clone "${botName}" dihapus permanen!`);
});

bot.command('perpanjang_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('Format: /perpanjang_clone [nama] [hari]');
    const botName = args[1], hari = parseInt(args[2]);
    if (isNaN(hari)) return ctx.reply('❌ Hari harus angka!');
    const sub = db.find(DB.clone_subscriptions, s => s.botName === botName);
    const base = sub && new Date(sub.expiredAt) > new Date() ? new Date(sub.expiredAt) : new Date();
    const expiredAt = new Date(base.getTime() + hari * 86400000).toISOString();
    db.upsert(DB.clone_subscriptions, s => s.botName === botName, { botName, expiredAt, updatedAt: new Date().toISOString() });
    ctx.reply(`✅ Clone "${botName}" diperpanjang *${hari} hari*!\n📅 Berlaku hingga: ${formatDateShort(expiredAt)}`, { parse_mode: 'Markdown' });
});

bot.command('list_clones', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const clones = db.read(DB.clones);
    if (!clones.length) return ctx.reply('📭 Belum ada clone.');
    let msg = `🤖 *DAFTAR CLONE BOT*\n\nTotal: ${clones.length}\n\n`;
    clones.forEach(c => {
        const running = activeCloneProcesses.has(c.botName);
        const sub     = db.find(DB.clone_subscriptions, s => s.botName === c.botName);
        const expired = isCloneExpired(c.botName);
        const sisa    = sisaHariClone(c.botName);
        const icon    = expired ? '⏰' : running ? '🟢' : '🔴';
        msg += `${icon} *${c.botName}* (@${c.username || '-'})\n`;
        msg += sub ? (expired ? `  ⏰ EXPIRED\n` : `  ⏳ Sisa ${sisa} hari\n`) : `  ♾️ Tanpa batas\n`;
    });
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ==================== /input COMMAND ====================
bot.command('input', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const text = ctx.message.text.split('\n').slice(1).join('\n').trim() ||
                 ctx.message.text.split(' ').slice(1).join(' ').trim();

    if (!text) {
        return ctx.reply(
            `📥 *INPUT PRODUK*\n\nFormat (kirim setelah /input):\n` +
            `\`\`\`\n/input\nKategori | Nama Produk | Nama Paket | Harga | Deskripsi\n\`\`\`\n\n` +
            `Contoh (1 produk banyak paket):\n` +
            `\`\`\`\n/input\nStreaming | Netflix | 1 Bulan | 50000 | Garansi 30 hari\nStreaming | Netflix | 3 Bulan | 130000\nStreaming | Spotify | 1 Bulan | 20000\nGaming | ML Diamond | 500 Diamond | 80000\n\`\`\`\n\n` +
            `• Produk yang sama nama tidak dibuat ulang\n• Paket baru ditambahkan ke produk yang ada\n• Bisa banyak baris sekaligus`,
            { parse_mode: 'Markdown' }
        );
    }

    const ikonKategori = { streaming: '🎬', gaming: '🎮', music: '🎵', vpn: '🔐', software: '💻', education: '📚', sosmed: '📱', tools: '🛠️' };
    const baris = text.split('\n').map(b => b.trim()).filter(b => b.length > 0);
    let berhasil = 0, gagal = 0, errorList = [];

    for (const brs of baris) {
        const parts = brs.split('|').map(p => p.trim());
        if (parts.length < 4) { gagal++; errorList.push(`❌ Format salah (kurang kolom): ${brs}`); continue; }
        const [namaKat, namaProd, namaPaket, hargaStr, ...descArr] = parts;
        const harga = parseInt(hargaStr.replace(/\D/g, ''));
        const deskripsi = descArr.join('|').trim() || '';
        if (!namaKat || !namaProd || !namaPaket || isNaN(harga)) { gagal++; errorList.push(`❌ Data tidak valid: ${brs}`); continue; }
        // Cari atau buat kategori
        let kat = db.find(DB.categories, c => c.nama.toLowerCase() === namaKat.toLowerCase());
        if (!kat) {
            const katId = uuidv4().slice(0, 8);
            const icon = ikonKategori[namaKat.toLowerCase()] || '📦';
            kat = { id: katId, nama: namaKat, icon, aktif: true, createdAt: new Date().toISOString() };
            db.push(DB.categories, kat);
        }
        // Cari produk yang sudah ada — JANGAN buat baru kalau sudah ada
        let prod = db.find(DB.products, p => p.nama.toLowerCase() === namaProd.toLowerCase() && p.kategori === kat.id);
        if (!prod) {
            const prodId = uuidv4().slice(0, 8);
            prod = { id: prodId, nama: namaProd, deskripsi, kategori: kat.id, aktif: true, createdAt: new Date().toISOString() };
            db.push(DB.products, prod);
        }
        // Tambahkan plan baru ke produk yang ada
        const planId = uuidv4().slice(0, 8);
        db.push(DB.plans, { id: planId, produk_id: prod.id, nama: namaPaket, harga, durasi: 30, aktif: true, createdAt: new Date().toISOString() });
        berhasil++;
    }

    let msg = `✅ *INPUT SELESAI!*\n\n✅ Berhasil: *${berhasil}*\n❌ Gagal: *${gagal}*`;
    if (errorList.length) msg += `\n\n*Error:*\n${errorList.slice(0, 5).join('\n')}${errorList.length > 5 ? `\n_...dan ${errorList.length - 5} lainnya_` : ''}`;
    return ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '📦 Lihat Produk',   callback_data: 'admin_produk' }, { text: '📥 Input Akun', callback_data: 'admin_input_akun' }],
        [{ text: '🔙 Admin',           callback_data: 'admin_panel' }],
    ]}});
});

// ==================== TEXT HANDLER ====================
bot.on('text', async (ctx, next) => {
    const text   = ctx.message?.text || '';
    const action = ctx.session?.action;

    // Trigger "pay" / "bayar" di private chat
    if (isPrivate(ctx) && !action) {
        const lower = text.toLowerCase().trim();
        const payTriggers = ['pay', 'bayar', 'payment', 'cara bayar', 'metode pembayaran', 'cara pembayaran'];
        if (payTriggers.some(t => lower === t || lower.startsWith(t + ' '))) {
            const qrisList = db.filter(DB.qris, q => q.aktif);
            if (!qrisList.length) {
                return ctx.reply('❌ Belum ada metode pembayaran.\nHubungi admin.');
            }
            let msg = `💳 *METODE PEMBAYARAN*\n${'─'.repeat(25)}\n\n`;
            const buttons = [];
            for (const q of qrisList) {
                msg += `💳 *${q.nama}*\n`;
                if (q.nomor)     msg += `📋 No: \`${q.nomor}\`\n`;
                if (q.atas_nama) msg += `👤 A/N: ${q.atas_nama}\n`;
                msg += '\n';
                if (q.qrisImage) buttons.push([{ text: `🖼️ QR ${q.nama}`, callback_data: `show_qr_${q.kode}` }]);
            }
            buttons.push([{ text: '🛍️ Belanja', callback_data: 'belanja' }, { text: '🔙 Menu', callback_data: 'back_to_menu' }]);
            await ctx.reply(msg + WATERMARK, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
            for (const q of qrisList) {
                if (q.qrisImage) {
                    try { await ctx.replyWithPhoto(q.qrisImage, { caption: `💳 QR ${q.nama}`, parse_mode: 'Markdown' }); } catch(e) {}
                }
            }
            return;
        }
    }

    // Input akun bulk
    if (action?.startsWith('input_akun_bulk_') && isAdminOrOwner(ctx.from.id)) {
        const planId = action.replace('input_akun_bulk_', '');
        const plan   = db.find(DB.plans, p => p.id === planId);
        const prod   = plan ? db.find(DB.products, p => p.id === plan.produk_id) : null;
        const baris  = text.split('\n').map(b => b.trim()).filter(b => b.length > 0);
        if (!baris.length) return ctx.reply('❌ Tidak ada akun terdeteksi. Satu baris = satu akun.');
        const result   = tambahBulkAkun(planId, baris);
        const { added, dupInBatch, dupOfExisting } = result;
        ctx.session.action = null;
        let msg = `✅ *BERHASIL INPUT AKUN!*\n\n📦 *${prod?.nama || '?'} — ${plan?.nama || planId}*\n\n📥 Dikirim: *${baris.length}*\n✅ Masuk stok: *${added.length}*\n`;
        if (dupInBatch > 0)    msg += `⚠️ Duplikat dalam input: *${dupInBatch}* _(baris sama di batch ini, tetap masuk)_\n`;
        if (dupOfExisting > 0) msg += `🔁 Sama dg stok aktif: *${dupOfExisting}* _(sudah ada di stok belum terpakai, tetap masuk)_\n`;
        msg += `\n📊 Total stok tersedia: *${hitungStokAkun(planId)} akun*`;
        return ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '📥 Input Lagi', callback_data: `input_akun_plan_${planId}` }, { text: '📦 Lihat Stok', callback_data: 'admin_lihat_stok_akun' }],
        ]}});
    }

    // Kirim akun manual via session
    if (action?.startsWith('kirim_manual_') && isAdminOrOwner(ctx.from.id)) {
        const invoiceId = action.replace('kirim_manual_', '');
        const order = db.find(DB.orders, o => o.id === invoiceId);
        ctx.session.action = null;
        if (!order) return ctx.reply('❌ Order tidak ditemukan!');

        const allManual = (order.items || []).every(item => isManualProduct(item.planId));
        try {
            if (allManual) {
                // Produk manual: kirim pesan singkat tanpa format akun
                await bot.telegram.sendMessage(order.userId,
                    `🔔 *INFO ORDER ANDA*\n\n🆔 Order: \`${invoiceId}\`\n\n${text}${WATERMARK}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                // Produk stok: kirim dengan format akun
                await bot.telegram.sendMessage(order.userId,
                    `📦 *AKUN ANDA*\n\n\`\`\`\n${text}\n\`\`\`\n\n🆔 Order: \`${invoiceId}\`\n🔒 _Jangan bagikan ke siapapun!_${WATERMARK}`,
                    { parse_mode: 'Markdown' }
                );
            }
            return ctx.reply(`✅ Pesan berhasil dikirim ke *${order.customerName}*!`, { parse_mode: 'Markdown' });
        } catch(e) { return ctx.reply(`❌ Gagal kirim: ${e.message}`); }
    }

    // Broadcast
    if (action === 'broadcast' && isOwner(ctx.from.id)) {
        ctx.session.action = null;
        const customers = db.read(DB.customers);
        let ok = 0, fail = 0;
        await ctx.reply('📢 Mengirim broadcast...');
        for (const c of customers) {
            try { await bot.telegram.sendMessage(c.id, `📢 *BROADCAST*\n\n${text}${WATERMARK}`, { parse_mode: 'Markdown' }); ok++; } catch(e) { fail++; }
        }
        return ctx.reply(`✅ Broadcast selesai!\n✔️ Berhasil: ${ok}\n❌ Gagal: ${fail}`);
    }

    // Group announce via session
    if (action?.startsWith('group_announce_') && isAdminOrOwner(ctx.from.id)) {
        const chatId = parseInt(action.replace('group_announce_', ''));
        ctx.session.action = null;
        try { await bot.telegram.sendMessage(chatId, `📢 *PENGUMUMAN*\n\n${text}${GRUP_WATERMARK}`, { parse_mode: 'Markdown' }); ctx.reply('✅ Pengumuman terkirim!'); }
        catch(e) { ctx.reply('❌ Gagal: ' + e.message); }
        return;
    }

    // Set rules via session
    if (action?.startsWith('setrules_')) {
        const chatId = action.replace('setrules_', '');
        db.upsert(DB.group_rules, r => r.chatId === chatId, { chatId, text, updatedAt: new Date().toISOString() });
        ctx.session.action = null;
        return ctx.reply('✅ Rules disimpan!');
    }

    // Set welcome via session
    if (action?.startsWith('setwelcome_')) {
        const chatId = action.replace('setwelcome_', '');
        db.upsert(DB.group_welcome, w => String(w.chatId) === String(chatId), { chatId, text, updatedAt: new Date().toISOString() });
        ctx.session.action = null;
        return ctx.reply('✅ Welcome disimpan!');
    }

    return next();
});

// ==================== BUKTI PEMBAYARAN (BUKPEM) ====================
// User kirim foto + caption invoice → bot forward ke admin dengan tombol konfirmasi/tolak

bot.on('photo', async (ctx, next) => {
    if (!isPrivate(ctx)) return next();
    if (!ctx.from) return next();

    const caption  = ctx.message?.caption || '';
    const lower    = caption.toLowerCase();

    // Deteksi: caption mengandung invoice ID atau kata kunci bukpem
    const bukpemKeywords = ['inv-', 'bukti', 'bukpem', 'transfer', 'bayar', 'payment', 'konfirmasi'];
    const isBukpem = bukpemKeywords.some(kw => lower.includes(kw));

    // Cek apakah user punya order waiting_payment
    const userOrders = db.filter(DB.orders, o => o.userId === ctx.from.id && o.status === 'waiting_payment');

    // Kalau tidak ada keyword bukpem DAN tidak ada order aktif → skip
    if (!isBukpem && userOrders.length === 0) return next();

    // Kalau kirim foto tapi TIDAK ada invoice di caption → ingatkan
    const invoiceMatch = caption.match(/INV-[A-Z0-9]+-[A-Z0-9]+/i);
    if (!invoiceMatch) {
        // Cek ada order waiting_payment tidak
        if (userOrders.length > 0) {
            const invoiceList = userOrders.map(o => `• \`${o.id}\` — ${formatRp(o.total)}`).join('\n');
            return ctx.reply(
                `⚠️ *Jangan lupa sertakan nomor invoice ya kak!*\n\n` +
                `Kirim ulang foto bukti pembayaran + tulis nomor invoice di caption.\n\n` +
                `📋 *Invoice kamu yang pending:*\n${invoiceList}\n\n` +
                `_Contoh caption: "Bukti bayar INV-20260429-001"_`,
                { parse_mode: 'Markdown' }
            );
        } else if (isBukpem) {
            // Ada keyword tapi tidak ada order — tetap proses
        } else {
            return next();
        }
    }

    // Cari invoice yang cocok dari caption
    let order = null;
    if (invoiceMatch) {
        order = db.find(DB.orders, o => o.id.toUpperCase() === invoiceMatch[0].toUpperCase());
    }
    // Kalau tidak ada invoice di caption, cari order waiting_payment milik user ini
    if (!order) {
        if (userOrders.length === 1) order = userOrders[0];
    }

    const photo  = ctx.message.photo;
    const fileId = photo[photo.length - 1].file_id;
    const customerName = ctx.from.first_name || '-';
    const username     = ctx.from.username ? `@${ctx.from.username}` : `ID: ${ctx.from.id}`;

    // Verifikasi dengan AI Vision
    const thinkingMsg = await ctx.reply('\u23f3 Memverifikasi pembayaran...');
    let aiVerified = false;
    let aiNote = '';

    if (config.aiKey && order) {
        try {
            const axios = require('axios');
            const fileInfo = await bot.telegram.getFile(fileId);
            const fileUrl = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fileInfo.file_path;
            const imgRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const base64Img = Buffer.from(imgRes.data).toString('base64');
            const ext = (fileInfo.file_path.split('.').pop() || 'jpg').toLowerCase();
            const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';

            const aiRes = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                model: 'mistral-small-latest',
                max_tokens: 200,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + base64Img } },
                        { type: 'text', text: 'Ini bukti pembayaran. Invoice: ' + order.id + ', Total: ' + formatRp(order.total) + '. Apakah ini bukti transfer/pembayaran valid? Nominalnya sesuai ' + formatRp(order.total) + '? Jawab JSON saja: {"valid":true/false,"nominal":"nominal terdeteksi","catatan":"penjelasan singkat"}' }
                    ]
                }]
            }, {
                headers: { 'Authorization': 'Bearer ' + config.aiKey, 'content-type': 'application/json' },
                timeout: 30000
            });

            const aiText = (aiRes.data && aiRes.data.choices && aiRes.data.choices[0] && aiRes.data.choices[0].message && aiRes.data.choices[0].message.content) ? aiRes.data.choices[0].message.content.trim() : '';
            try {
                const clean = aiText.replace(/```json|```/g, '').trim();
                const aiResult = JSON.parse(clean);
                aiVerified = aiResult.valid === true;
                aiNote = aiResult.catatan || '';
                const nominalDeteksi = aiResult.nominal || '-';

                if (aiVerified) {
                    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
                    await ctx.reply('\u2705 *Pembayaran terverifikasi AI!*\n\n\ud83c\udd94 Invoice: ' + order.id + '\n\ud83d\udcb0 Nominal: ' + nominalDeteksi + '\n\ud83e\udd16 ' + aiNote + '\n\nPesanan sedang diproses!' + WATERMARK, { parse_mode: 'Markdown' });

                    db.update(DB.orders, o => o.id === order.id, o => { o.status = 'processing'; o.confirmedAt = new Date().toISOString(); o.confirmedBy = 'AI'; });

                    const akuns = db.filter(DB.akun_stok, a => a.planId === (order.items[0] && order.items[0].planId) && !a.used);
                    if (akuns.length > 0) {
                        const akun = akuns[0];
                        db.update(DB.akun_stok, a => a.id === akun.id, a => { a.used = true; a.usedBy = ctx.from.id; });
                        db.update(DB.orders, o => o.id === order.id, o => { o.status = 'completed'; o.akunData = akun.data; });
                        await ctx.reply('\ud83c\udf89 *Akun kamu sudah siap!*\n\n```\n' + akun.data + '\n```\n\n_Simpan baik-baik ya!_' + WATERMARK, { parse_mode: 'Markdown' });
                    } else {
                        db.update(DB.orders, o => o.id === order.id, o => { o.status = 'completed'; });
                        await ctx.reply('\u2705 Order dikonfirmasi! Akun akan segera dikirim admin.' + WATERMARK);
                    }

                    const admins2 = db.read(DB.admins);
                    const targets2 = [...admins2.map(a => a.id)];
                    if (config.ownerId && !targets2.includes(config.ownerId)) targets2.push(config.ownerId);
                    for (const adminId of targets2) {
                        try { await bot.telegram.sendMessage(adminId, '\ud83e\udd16 *AUTO KONFIRMASI AI*\n\n\ud83d\udc64 ' + customerName + ' (' + username + ')\n\ud83c\udd94 ' + order.id + '\n\ud83d\udcb0 ' + formatRp(order.total) + '\n\u2705 Nominal: ' + nominalDeteksi + '\n\ud83d\udcdd ' + aiNote, { parse_mode: 'Markdown' }); } catch(e) {}
                    }
                    return;
                }
            } catch(parseErr) { aiNote = 'Tidak bisa parse hasil AI'; }
        } catch(aiErr) {
            console.error('[AI Vision]', aiErr.message);
            aiNote = 'AI tidak tersedia';
        }
    }

    // Manual verification
    try { await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id); } catch(e) {}
    await ctx.reply('\u2705 *Bukti pembayaran diterima!*\n\nAdmin akan segera memverifikasi.\n' + (order ? '\ud83c\udd94 Invoice: ' + order.id : '\u26a0\ufe0f Invoice tidak terdeteksi') + WATERMARK, { parse_mode: 'Markdown' });

    const aiInfo = aiNote && aiNote !== 'AI tidak tersedia' ? '\n\ud83e\udd16 AI: _' + aiNote + '_' : '';
    const infoCaption = order
        ? '\ud83d\udcf8 *BUKTI PEMBAYARAN*\n\n\ud83d\udc64 ' + customerName + ' (' + username + ')\n\ud83c\udd94 Invoice: ' + order.id + '\n\ud83d\udcb0 Total: *' + formatRp(order.total) + '*\n\ud83d\udce6 ' + (order.items||[]).map(function(i){return i.planNama;}).join(', ') + aiInfo + (caption ? '\n\n\ud83d\udcdd _"' + caption + '"_' : '')
        : '\ud83d\udcf8 *BUKTI PEMBAYARAN*\n\n\ud83d\udc64 ' + customerName + ' (' + username + ')\n\u26a0\ufe0f _Invoice tidak terdeteksi_' + aiInfo + (caption ? '\n\n\ud83d\udcdd _"' + caption + '"_' : '');

    const buttons = order ? [
        [{ text: '\u2705 Konfirmasi ' + order.id.slice(-8), callback_data: 'konfirmasi_order_' + order.id }, { text: '\u274c Tolak', callback_data: 'batalkan_order_' + order.id }],
        [{ text: '\ud83d\udd0d Detail Order', callback_data: 'detail_order_' + order.id }]
    ] : [[{ text: '\u23f3 Lihat Order Pending', callback_data: 'admin_orders_pending' }]];

    const admins = db.read(DB.admins);
    const targets = [...admins.map(function(a){return a.id;})];
    if (config.ownerId && !targets.includes(config.ownerId)) targets.push(config.ownerId);
    for (const adminId of targets) {
        try { await bot.telegram.sendPhoto(adminId, fileId, { caption: infoCaption, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); } catch(e) {}
    }
});

// ==================== CRON JOBS ====================
// Auto laporan harian jam 20:00
cron.schedule('0 20 * * *', async () => {
    try {
        if (!config.ownerId) return;
        const orders  = db.read(DB.orders);
        const today   = new Date().toDateString();
        const todayO  = orders.filter(o => new Date(o.createdAt).toDateString() === today);
        const rev     = todayO.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0);
        const stokHabis = db.read(DB.plans).filter(p => hitungStokAkun(p.id) === 0).length;
        await bot.telegram.sendMessage(config.ownerId,
            `📊 *LAPORAN HARIAN*\n📅 ${new Date().toLocaleDateString('id-ID')}\n\n📦 Order: ${todayO.length}\n✅ Selesai: ${todayO.filter(o => o.status === 'completed').length}\n⏳ Pending: ${todayO.filter(o => o.status === 'waiting_payment').length}\n💰 Revenue: *${formatRp(rev)}*\n❌ Stok habis: ${stokHabis} plan`,
            { parse_mode: 'Markdown' }
        );
    } catch(e) {}
}, { timezone: 'Asia/Jakarta' });

// Auto cancel order pending >3 hari
cron.schedule('0 0 * * *', async () => {
    try {
        const cutoff = new Date(Date.now() - 3 * 86400000);
        const stale  = db.filter(DB.orders, o => o.status === 'waiting_payment' && new Date(o.createdAt) < cutoff);
        for (const order of stale) {
            db.update(DB.orders, o => o.id === order.id, o => { o.status = 'cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = 'Auto-cancel (3 hari)'; });
            try { await bot.telegram.sendMessage(order.userId, `❌ Order \`${order.id}\` otomatis dibatalkan (3 hari tanpa konfirmasi).`, { parse_mode: 'Markdown' }); } catch(e) {}
        }
        if (stale.length) await sendToAdmins(`🤖 Auto-cancel: ${stale.length} order dibatalkan.`);
    } catch(e) {}
});

// Alert stok habis jam 09:00
cron.schedule('0 9 * * *', async () => {
    try {
        const plans  = db.read(DB.plans);
        const habis  = plans.filter(p => hitungStokAkun(p.id) === 0 && p.aktif !== false);
        const kritis = plans.filter(p => { const s = hitungStokAkun(p.id); return s > 0 && s <= 3 && p.aktif !== false; });
        if (!habis.length && !kritis.length) return;
        let msg = `⚠️ *ALERT STOK AKUN*\n\n`;
        if (habis.length) { msg += `❌ *HABIS:*\n`; habis.forEach(p => { msg += `• ${p.nama} [\`${p.id}\`]\n`; }); msg += '\n'; }
        if (kritis.length) { msg += `⚠️ *KRITIS (≤3):*\n`; kritis.forEach(p => { msg += `• ${p.nama}: ${hitungStokAkun(p.id)} sisa\n`; }); }
        await sendToAdmins(msg, { reply_markup: { inline_keyboard: [[{ text: '📥 Input Akun', callback_data: 'admin_input_akun' }]] }});
    } catch(e) {}
}, { timezone: 'Asia/Jakarta' });

// Auto check clone expired setiap jam
cron.schedule('0 * * * *', async () => {
    try {
        const clones = db.read(DB.clones);
        for (const clone of clones) {
            if (isCloneExpired(clone.botName) && activeCloneProcesses.has(clone.botName)) {
                await stopCloneBot(clone.botName);
                db.update(DB.clones, c => c.botName === clone.botName, c => { c.aktif = false; });
                try { await bot.telegram.sendMessage(config.ownerId, `⏰ Clone *${clone.botName}* dihentikan karena masa aktif habis.\nGunakan /perpanjang_clone ${clone.botName} [hari]`, { parse_mode: 'Markdown' }); } catch(e) {}
            }
        }
    } catch(e) {}
});

// ==================== HELPER: LIST PRODUK & CARA BAYAR ====================

async function replyListProduk(ctx, replyMsgId) {
    const categories = db.filter(DB.categories, c => c.aktif);
    if (!categories.length) {
        return ctx.reply('❌ Belum ada produk tersedia.', replyMsgId ? { reply_to_message_id: replyMsgId } : {});
    }
    let msg = `🛍️ *PRODUK TERSEDIA*\n${'─'.repeat(25)}\n\n`;
    for (const cat of categories) {
        const products = db.filter(DB.products, p => p.kategori === cat.id && p.aktif !== false);
        if (!products.length) continue;
        msg += `${cat.icon || '📦'} *${cat.nama}*\n`;
        for (const p of products) {
            const plans = db.filter(DB.plans, pl => pl.produk_id === p.id && pl.aktif !== false);
            for (const pl of plans) {
                const stok = hitungStokAkun(pl.id);
                const icon = stok === 0 ? '❌' : '✅';
                msg += `  ${icon} ${pl.nama} — *${formatRp(pl.harga)}*\n`;
            }
        }
        msg += '\n';
    }
    msg += `_Order via DM bot ya!_`;
    const opts = { parse_mode: 'Markdown' };
    if (replyMsgId) opts.reply_to_message_id = replyMsgId;
    await ctx.reply(msg + GRUP_WATERMARK, opts);
}

async function replyCaraBayar(ctx, replyMsgId) {
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) return;
    let msg = `💳 *METODE PEMBAYARAN*\n${'─'.repeat(25)}\n\n`;
    for (const q of qrisList) {
        msg += `💳 *${q.nama}*\n`;
        if (q.nomor)     msg += `📋 No: \`${q.nomor}\`\n`;
        if (q.atas_nama) msg += `👤 A/N: ${q.atas_nama}\n`;
        msg += '\n';
    }
    msg += `_Kirim bukti pembayaran ke admin setelah transfer._`;
    const buttons = qrisList.filter(q => q.qrisImage).map(q => [{ text: `🖼️ QR ${q.nama}`, callback_data: `show_qr_${q.kode}` }]);
    buttons.push([{ text: '🛍️ Mulai Belanja', callback_data: 'belanja' }]);
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
    if (replyMsgId) opts.reply_to_message_id = replyMsgId;
    await ctx.reply(msg, opts);
    if (isPrivate(ctx)) {
        for (const q of qrisList) {
            if (q.qrisImage) {
                try {
                    await ctx.replyWithPhoto(q.qrisImage, {
                        caption: `💳 *${q.nama}*${q.nomor ? `\n📋 No: ${q.nomor}` : ''}`,
                        parse_mode: 'Markdown'
                    });
                } catch(e) {}
            }
        }
    }
}

// ==================== COMMAND /list & /pay DI GRUP ====================

bot.command('list', async (ctx) => {
    if (isPrivate(ctx)) {
        return ctx.reply(`🏪 *${config.name}*\nPilih menu:${WATERMARK}`, {
            parse_mode: 'Markdown',
            reply_markup: buildMainKeyboard(ctx.from.id)
        });
    }
    await replyListProduk(ctx, ctx.message.message_id);
});

// ==================== /cek_token ====================

bot.command('cek_token', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) return ctx.reply('❌ Format: /cek_token [token]', { parse_mode: 'Markdown' });
    const token = args[0].trim();
    await ctx.reply('⏳ Mengecek token...', { parse_mode: 'Markdown' });
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await res.json();
        if (!data.ok) {
            return ctx.reply(`❌ *Token tidak valid!*\n\nPastikan token benar.`, { parse_mode: 'Markdown' });
        }
        const b = data.result;
        let msg = `✅ *INFO BOT*\n${'─'.repeat(25)}\n\n`;
        msg += `🤖 Nama: *${escapeMd(b.first_name)}*\n`;
        msg += `📛 Username: @${b.username}\n`;
        msg += `🆔 Bot ID: \`${b.id}\`\n`;
        msg += `🔒 Token: \`${token}\`\n`;
        msg += `\n_Token valid ✅_`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch(e) {
        await ctx.reply(`❌ Gagal mengecek token.\nError: ${e.message}`, { parse_mode: 'Markdown' });
    }
});

// ==================== /daftar_kategori & /daftar_produk ====================

bot.command('daftar_kategori', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const cats = db.read(DB.categories);
    if (!cats.length) return ctx.reply('❌ Belum ada kategori.');
    let msg = `🗂️ *DAFTAR KATEGORI*\n${'─'.repeat(25)}\n\n`;
    cats.forEach(c => {
        msg += `${c.aktif ? '✅' : '❌'} ${c.icon || '📦'} *${escapeMd(c.nama)}*\n`;
        msg += `   ID: \`${c.id}\`\n\n`;
    });
    msg += `_Total: ${cats.length} kategori_`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('daftar_produk', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const cats     = db.read(DB.categories);
    const products = db.read(DB.products);
    const plans    = db.read(DB.plans);
    if (!products.length) return ctx.reply('❌ Belum ada produk.');
    let msg = `📦 *DAFTAR PRODUK & ID*\n${'─'.repeat(25)}\n\n`;
    for (const cat of cats) {
        const prods = products.filter(p => p.kategori === cat.id);
        if (!prods.length) continue;
        msg += `🗂️ *${escapeMd(cat.nama)}* (\`${cat.id}\`)\n`;
        for (const p of prods) {
            msg += `  ${p.aktif !== false ? '✅' : '❌'} ${p.icon || '📦'} *${escapeMd(p.nama)}*\n`;
            msg += `     Produk ID: \`${p.id}\`\n`;
            const pls = plans.filter(pl => pl.produk_id === p.id);
            for (const pl of pls) {
                const stok = hitungStokAkun(pl.id);
                const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
                msg += `     ${icon} ${escapeMd(pl.nama)} — *${formatRp(pl.harga)}* (stok: ${stok})\n`;
                msg += `        Plan ID: \`${pl.id}\`\n`;
            }
        }
        msg += '\n';
    }
    // Produk tanpa kategori
    const noCat = products.filter(p => !cats.find(c => c.id === p.kategori));
    if (noCat.length) {
        msg += `🗂️ *Tanpa Kategori*\n`;
        noCat.forEach(p => { msg += `  📦 *${escapeMd(p.nama)}* — ID: \`${p.id}\`\n`; });
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ==================== DOT COMMAND / GROUP NOTES ====================
// Owner/Admin bisa set: /setnote netflix [isi pesan]
// Di grup, ketik .netflix → bot auto reply

bot.command('setnote', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply(
        '📝 *SET NOTE*\n\nFormat:\n`/setnote [nama] [isi pesan]`\n\nContoh:\n`/setnote netflix Netflix 1 Bulan - 15.000\nNetflix 3 Bulan - 40.000`\n\nLihat semua note: /listnote\nHapus note: /delnote [nama]',
        { parse_mode: 'Markdown' }
    );
    const nama = args[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
    const isi  = args.slice(1).join(' ');
    if (!nama) return ctx.reply('❌ Nama note hanya boleh huruf, angka, dan underscore.');
    db.upsert(DB.group_notes, n => n.nama === nama, {
        nama, isi, createdBy: ctx.from.id, updatedAt: new Date().toISOString()
    });
    ctx.reply(`✅ Note *${nama}* disimpan!\n\nCara pakai di grup: ketik \`.${nama}\``, { parse_mode: 'Markdown' });
});

bot.command('delnote', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const nama = (ctx.message.text.split(' ')[1] || '').toLowerCase();
    if (!nama) return ctx.reply('Format: /delnote [nama]');
    const n = db.remove(DB.group_notes, note => note.nama === nama);
    ctx.reply(n ? `✅ Note *${nama}* dihapus.` : `❌ Note *${nama}* tidak ditemukan.`, { parse_mode: 'Markdown' });
});

bot.command('listnote', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const notes = db.read(DB.group_notes);
    if (!notes.length) return ctx.reply('❌ Belum ada note.\n\nBuat note: /setnote [nama] [isi]');
    let msg = `📝 *DAFTAR NOTE (${notes.length})*\n${'─'.repeat(22)}\n\n`;
    notes.forEach(n => { msg += `• \`.${n.nama}\`\n`; });
    msg += `\n_Ketik nama note di grup untuk tampilkan._`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Handler dot-command di grup: .netflix, .harga, dll
bot.on('message', async (ctx, next) => {
    if (!ctx.message?.text) return next();
    const text = ctx.message.text.trim();
    if (!text.startsWith('.')) return next();

    const keyword = text.slice(1).split(' ')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!keyword) return next();

    const note = db.find(DB.group_notes, n => n.nama === keyword);
    if (!note) return next();

    try {
        await ctx.reply(note.isi, {
            reply_to_message_id: ctx.message.message_id
        });
    } catch(e) {}
});

// ==================== HELPER: REPLY LIST PRODUK & CARA BAYAR ====================
async function replyListProduk(ctx, replyToId = null) {
    const categories = db.filter(DB.categories, c => c.aktif);
    if (!categories.length) {
        return ctx.reply('❌ Belum ada produk tersedia.' + GRUP_WATERMARK, {
            reply_to_message_id: replyToId || undefined
        });
    }
    let msg = `🛍️ *PRODUK TERSEDIA — ${config.name}*\n\n`;
    for (const cat of categories) {
        const products = db.filter(DB.products, p => p.kategori === cat.id && p.aktif !== false);
        if (!products.length) continue;
        msg += `${cat.icon || '📦'} *${cat.nama}*\n`;
        for (const p of products) {
            const plans = db.filter(DB.plans, pl => pl.produk_id === p.id && pl.aktif !== false);
            plans.forEach(pl => {
                const stok = hitungStokAkun(pl.id);
                const icon = stok === 0 ? '❌' : stok <= 3 ? '⚠️' : '✅';
                msg += `  ${icon} ${pl.nama} — *${formatRp(pl.harga)}*\n`;
            });
        }
        msg += '\n';
    }
    const botInfo = await bot.telegram.getMe().catch(() => ({ username: 'bot' }));
    msg += `📱 Order via DM: @${botInfo.username}`;
    await ctx.reply(msg + GRUP_WATERMARK, {
        parse_mode: 'Markdown',
        reply_to_message_id: replyToId || undefined,
        reply_markup: { inline_keyboard: [[{ text: '🛍️ Order Sekarang', url: `https://t.me/${botInfo.username}` }]] }
    });
}

async function replyCaraBayar(ctx, replyToId = null) {
    const qrisList = db.filter(DB.qris, q => q.aktif);
    if (!qrisList.length) {
        return ctx.reply('❌ Belum ada metode pembayaran. Hubungi admin.' + GRUP_WATERMARK, {
            reply_to_message_id: replyToId || undefined
        });
    }
    let msg = `💳 *METODE PEMBAYARAN*\n${'─'.repeat(25)}\n\n`;
    for (const q of qrisList) {
        msg += `💳 *${q.nama}*\n`;
        if (q.nomor)     msg += `📋 No: \`${q.nomor}\`\n`;
        if (q.atas_nama) msg += `👤 A/N: ${q.atas_nama}\n`;
        msg += '\n';
    }
    const botInfo = await bot.telegram.getMe().catch(() => ({ username: 'bot' }));
    msg += `📱 Kirim bukti bayar via DM: @${botInfo.username}`;
    await ctx.reply(msg + GRUP_WATERMARK, {
        parse_mode: 'Markdown',
        reply_to_message_id: replyToId || undefined,
        reply_markup: { inline_keyboard: [[{ text: '💰 Order & Bayar', url: `https://t.me/${botInfo.username}` }]] }
    });
}

// ==================== TRIGGERWORD HANDLER ====================
// Cooldown map: userId -> { pay: timestamp, list: timestamp }
const triggerCooldown = new Map();

bot.on('message', async (ctx, next) => {
    if (!ctx.message?.text) return next();
    if (ctx.session?.action) return next();

    const text = ctx.message.text.toLowerCase().trim();
    const userId = ctx.from?.id;
    const now = Date.now();
    const COOLDOWN_MS = 30000;

    // ── TRIGGER LIST ──
    const listTriggers = [
        // list / katalog
        'list', 'katalog', 'catalog', 'catlog', 'katlog',
        // dengan kak/min
        'kak list', 'kak catalog', 'kak katalog', 'kak produk', 'kak barang',
        'min list', 'min catalog', 'min katalog', 'min produk',
        // frasa umum
        'list produk', 'daftar produk', 'ada apa aja', 'ada apa saja',
        'jual apa', 'jual apa aja', 'produk apa', 'mau lihat produk',
        'lihat produk', 'show produk', 'apa yang dijual', 'ada produk apa',
        'mau order', 'mau beli', 'mo order', 'mo beli',
        'harga berapa', 'harganya', 'info produk', 'info harga',
    ];
    // Trigger dinamis dari nama produk & kategori di DB
    const _dynProds = db.read(DB.products).map(p => p.nama?.toLowerCase()).filter(Boolean);
    const _dynCats  = db.read(DB.categories).map(c => c.nama?.toLowerCase()).filter(Boolean);
    const _dynAll   = [...new Set([..._dynProds, ..._dynCats])];

    const listMatched =
        listTriggers.some(t => text.includes(t)) ||
        _dynAll.some(t => text.includes(t));

    if (listMatched) {
        const cd = triggerCooldown.get(userId) || {};
        if (cd.list && now - cd.list < COOLDOWN_MS) return next();
        triggerCooldown.set(userId, { ...cd, list: now });

        if (isPrivate(ctx)) {
            await ctx.reply(`🏪 *${config.name}*\nPilih menu di bawah:${WATERMARK}`, {
                parse_mode: 'Markdown',
                reply_markup: buildMainKeyboard(ctx.from.id)
            });
        } else {
            await replyListProduk(ctx, ctx.message.message_id);
        }
        return;
    }

    // ── TRIGGER BAYAR ──
    const payTriggers = [
        'kak pay', 'kak bayar', 'kak payment', 'kak transfer', 'kak rekening',
        'cara bayar', 'metode bayar', 'cara pembayaran', 'metode pembayaran',
        'cara transfer', 'cara tf', 'no rek', 'nomor rekening',
        'mau bayar', 'gimana bayar', 'bisa bayar', 'mau transfer',
        'bayar gimana', 'bayar kemana', 'transfer kemana', 'tf kemana'
    ];
    // kata tunggal yang match word boundary
    const payTriggersSingle = ['bayar', 'pay', 'payment', 'transfer', 'rekening', 'qris'];

    const payMatched =
        payTriggers.some(t => text.includes(t)) ||
        payTriggersSingle.some(t => new RegExp(`(?<![a-z])${t}(?![a-z])`).test(text));

    if (!payMatched) return next();

    const cd = triggerCooldown.get(userId) || {};
    if (cd.pay && now - cd.pay < COOLDOWN_MS) return next();
    triggerCooldown.set(userId, { ...cd, pay: now });

    await replyCaraBayar(ctx, isGroup(ctx) ? ctx.message.message_id : null);
});



// ==================== UPDATE CLONE SCRIPT ====================

async function updateCloneScript(botName) {
    const cloneDir = path.join(DATA_ROOT, 'clones', botName);
    const scriptPath = path.join(cloneDir, 'bot.js');

    if (!fs.existsSync(cloneDir)) return { ok: false, msg: `Clone dir tidak ditemukan: ${cloneDir}` };

    const clone = db.find(DB.clones, c => c.botName === botName);
    if (!clone) return { ok: false, msg: `Clone tidak ada di DB: ${botName}` };

    try {
        const newScript = generateCloneScript(clone.botToken, botName, clone.ownerId, DATA_ROOT);
        fs.writeFileSync(scriptPath, newScript, 'utf8');
        console.log(`[Update] ${botName} script updated (${newScript.length} bytes)`);
        return { ok: true };
    } catch(e) {
        console.error(`[Update] Failed ${botName}:`, e.message);
        return { ok: false, msg: e.message };
    }
}

bot.command('update_clone', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const botName = ctx.message.text.split(' ')[1];
    if (!botName) return ctx.reply('Format: /update_clone [nama]\nContoh: /update_clone MyShop\n\nUpdate semua: /update_all_clones');
    await ctx.reply(`⏳ Mengupdate clone *${botName}*...`, { parse_mode: 'Markdown' });
    const result = await updateCloneScript(botName);
    if (!result.ok) return ctx.reply(`❌ Gagal update: ${result.msg}`);
    // Auto restart
    const wasRunning = activeCloneProcesses.has(botName);
    if (wasRunning) {
        try { activeCloneProcesses.get(botName)?.kill('SIGTERM'); activeCloneProcesses.delete(botName); } catch(e) {}
        await new Promise(r => setTimeout(r, 1500));
        await launchCloneBot(botName, db.find(DB.clones, c => c.botName === botName)?.botToken, db.find(DB.clones, c => c.botName === botName)?.ownerId).catch(()=>{});
    }
    ctx.reply(`✅ Clone *${botName}* berhasil diupdate${wasRunning ? ' & direstart' : ''}!\n\n_Kalau belum jalan: /start_clone ${botName}_`, { parse_mode: 'Markdown' });
});

bot.command('update_all_clones', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const clones = db.read(DB.clones);
    if (!clones.length) return ctx.reply('❌ Belum ada clone.');

    const msg = await ctx.reply(`⏳ Mengupdate & merestart *${clones.length}* clone...`, { parse_mode: 'Markdown' });
    let ok = 0, fail = 0, failList = [];

    for (const clone of clones) {
        const result = await updateCloneScript(clone.botName);
        if (!result.ok) { fail++; failList.push(clone.botName); continue; }
        if (activeCloneProcesses.has(clone.botName)) {
            try { activeCloneProcesses.get(clone.botName)?.kill('SIGTERM'); activeCloneProcesses.delete(clone.botName); } catch(e) {}
            await new Promise(r => setTimeout(r, 1000));
        }
        try {
            await launchCloneBot(clone.botName, clone.botToken, clone.ownerId);
            ok++;
        } catch(e) { fail++; failList.push(clone.botName + '(restart)'); }
        await new Promise(r => setTimeout(r, 800));
    }

    const summary = `✅ *Update & Restart Selesai!*\n\n✅ Berhasil: ${ok} clone\n` +
        (fail ? `❌ Gagal: ${fail} (${failList.join(', ')})\n` : '') +
        `\n_Semua clone sudah pakai script terbaru!_\n_Set AI key di tiap clone: /set\_ai\_key [key]_`;

    try { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, summary, { parse_mode: 'Markdown' }); }
    catch(e) { ctx.reply(summary, { parse_mode: 'Markdown' }); }
});

// ==================== PANDUAN LENGKAP ====================

bot.action('owner_guide_full', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    await safeAnswerCbQuery(ctx);
    await ctx.reply('📖 *PANDUAN BOT LENGKAP*\n' + '─'.repeat(25) + '\n\nPilih kategori panduan:', {
        parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '🛍️ Produk & Toko',     callback_data: 'guide_produk' }],
            [{ text: '💳 Pembayaran',          callback_data: 'guide_bayar' }],
            [{ text: '👮 Admin & Order',       callback_data: 'guide_admin' }],
            [{ text: '🤖 Clone Bot',           callback_data: 'owner_guide_clone' }],
            [{ text: '🤖 AI Chatbot',          callback_data: 'guide_ai' }],
            [{ text: '👥 Manajemen Grup',      callback_data: 'guide_grup' }],
            [{ text: '📝 Dot-Command (Notes)', callback_data: 'guide_note' }],
            [{ text: '🔙 Owner Panel',         callback_data: 'owner_panel' }]
        ]}
    });
});

bot.action('guide_produk', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '🛍️ *PANDUAN PRODUK & TOKO*\n' + '─'.repeat(25) + '\n\n' +
        '*KATEGORI:*\n' +
        '`/tambah_kategori [id] [nama] [icon]`\n' +
        'Contoh: `/tambah_kategori netflix Netflix 📺`\n\n' +
        '`/hapus_kategori [id]`\n' +
        '`/daftar_kategori` — Lihat semua\n\n' +
        '*PRODUK:*\n' +
        '`/tambah_produk [kat_id] [nama]`\n' +
        'Contoh: `/tambah_produk netflix Netflix Premium`\n\n' +
        '`/hapus_produk [id]`\n' +
        '`/daftar_produk` — Lihat semua ID\n\n' +
        '*PAKET / PLAN:*\n' +
        '`/tambah_plan [prod_id] [nama] [harga] [durasi]`\n' +
        'Contoh: `/tambah_plan PROD1 "1 Bulan" 15000 30`\n\n' +
        '`/hapus_plan [id]`\n\n' +
        '*INPUT MASSAL:*\n' +
        '`/input` lalu baris baru:\n`Kategori | Produk | Paket | Harga`\n\n' +
        '*STOK AKUN:*\n' +
        '`/stok_akun [plan_id]` — Upload stok\n' +
        '`/lihat_stok [plan_id]` — Cek stok',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Panduan', callback_data: 'owner_guide_full' }]] }}
    );
});

bot.action('guide_bayar', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '💳 *PANDUAN PEMBAYARAN*\n' + '─'.repeat(25) + '\n\n' +
        '*TAMBAH METODE BAYAR:*\n' +
        '`/tambah_qris [kode] [nama] [nomor]`\n' +
        'Contoh: `/tambah_qris bca BCA 1234567890`\n\n' +
        '*UPLOAD GAMBAR QR:*\n' +
        'Kirim foto QR → reply foto → ketik:\n`/upload_qris [kode]`\n\n' +
        '*PERINTAH LAIN:*\n' +
        '`/list_qris` — Daftar semua\n' +
        '`/hapus_qris [kode]` — Hapus\n\n' +
        '*KONFIRMASI PEMBAYARAN:*\n' +
        'Customer kirim bukti bayar → notif ke admin\nAdmin klik ✅ Konfirmasi di panel order\n\n' +
        '*AUTO KONFIRMASI AI:*\n' +
        'Aktifkan AI → bot otomatis verifikasi bukti bayar',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Panduan', callback_data: 'owner_guide_full' }]] }}
    );
});

bot.action('guide_admin', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '👮 *PANDUAN ADMIN*\n' + '─'.repeat(25) + '\n\n' +
        '*TAMBAH/HAPUS ADMIN:*\n' +
        '`/tambah_admin [user_id] [nama]`\n' +
        '`/hapus_admin [user_id]`\n\n' +
        '*BLOKIR USER:*\n' +
        '`/blokir [user_id] [alasan]`\n' +
        '`/unblokir [user_id]`\n\n' +
        '*KELOLA ORDER:*\n' +
        '`/cekorder [id]` — Cek status\n' +
        '`/konfirmasi [id]` — Konfirmasi bayar\n' +
        '`/tolak [id]` — Tolak order\n' +
        '`/kirim_akun [user_id] [akun]` — Kirim manual\n\n' +
        '*BROADCAST:*\n' +
        'Tombol 📢 Broadcast di Owner Panel\n\n' +
        '*PENGATURAN BOT:*\n' +
        '`/set_nama [nama]` — Ganti nama bot\n' +
        '`/set_timezone [zona]` — Ganti timezone\n' +
        'Contoh: `/set_timezone Asia/Jakarta`',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Panduan', callback_data: 'owner_guide_full' }]] }}
    );
});

bot.action('guide_ai', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const name = config.name || 'Toko';
    await ctx.reply(
        '🤖 *PANDUAN AI (MISTRAL)*\n' + '─'.repeat(25) + '\n\n' +
        '*SETUP AI:*\n' +
        '1. Daftar di https://console.mistral.ai\n' +
        '2. Buat API Key (gratis)\n' +
        '3. Kirim: `/set_ai_key [key_kamu]`\n' +
        '4. Aktifkan: `/ai_on`\n\n' +
        '*FITUR AI:*\n' +
        '• Auto-reply chat privat\n' +
        '• Auto-reply di grup\n' +
        '• Verifikasi bukti bayar otomatis\n\n' +
        '*PERINTAH AI:*\n' +
        '`/ai_on` — Aktifkan AI private\n' +
        '`/ai_off` — Nonaktifkan AI private\n' +
        '`/ai_grup_on` — AI di grup\n' +
        '`/ai_grup_off` — Matikan AI grup\n' +
        '`/ai_status` — Cek status\n' +
        '`/set_ai_prompt [prompt]` — Atur kepribadian\n\n' +
        '*CONTOH PROMPT:*\n' +
        '`/set_ai_prompt Kamu CS toko ' + name + '. Jawab ramah & singkat. Arahkan ke /menu untuk order.`',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '⚙️ AI Settings', callback_data: 'owner_ai_settings' }],
            [{ text: '🔙 Panduan',     callback_data: 'owner_guide_full' }]
        ]}}
    );
});

bot.action('guide_grup', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '👥 *PANDUAN MANAJEMEN GRUP*\n' + '─'.repeat(25) + '\n\n' +
        '*SETUP BOT DI GRUP:*\n' +
        '1. Tambah bot ke grup\n' +
        '2. Jadikan bot Admin grup\n' +
        '3. Ketik `/manage` di grup\n\n' +
        '*FITUR GRUP:*\n' +
        '🔗 Anti-Link — Hapus pesan berisi link\n' +
        '🤐 Anti-Kasar — Warn + kick 3x\n' +
        '👋 Welcome — Sambut member baru\n' +
        '📜 Rules — Atur peraturan grup\n' +
        '⚠️ Warn Member — Peringatan manual\n' +
        '🔇 Mute — Diam sementara\n' +
        '🚫 Kick — Keluarkan member\n\n' +
        '*COMMAND DI GRUP:*\n' +
        '`/manage` — Panel kelola grup\n' +
        '`/rules` — Tampilkan peraturan\n' +
        '`/list` — Tampilkan produk\n' +
        '`/pay` — Tampilkan cara bayar\n\n' +
        '*DOT-COMMAND:*\n' +
        'Ketik `.nama` untuk tampilkan info cepat',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Panduan', callback_data: 'owner_guide_full' }]] }}
    );
});

bot.action('guide_note', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '📝 *PANDUAN DOT-COMMAND (NOTES)*\n' + '─'.repeat(25) + '\n\n' +
        'Member grup cukup ketik `.nama` dan bot auto-reply dengan info yang sudah disimpan.\n\n' +
        '*CARA SETUP:*\n' +
        '`/setnote [nama] [isi pesan]`\n\n' +
        'Contoh:\n' +
        '`/setnote netflix`\n' +
        '`⚠️ STOK NETFLIX READY!`\n' +
        '`◇ 1 Bulan — Rp15.000`\n' +
        '`◇ 3 Bulan — Rp40.000`\n\n' +
        '*Cara pakai di grup:*\n' +
        'Member ketik `.netflix` → bot reply otomatis\n\n' +
        '*Perintah lain:*\n' +
        '`/listnote` — Lihat semua note\n' +
        '`/delnote [nama]` — Hapus note\n\n' +
        '*Tips:*\n' +
        '• Nama: huruf, angka, underscore saja\n' +
        '• Contoh lain: `.harga` `.cara` `.syarat` `.promo`',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
            [{ text: '📋 List Note', callback_data: 'owner_listnote' }],
            [{ text: '🔙 Panduan',   callback_data: 'owner_guide_full' }]
        ]}}
    );
});

bot.action('owner_listnote', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const notes = db.read(DB.group_notes);
    if (!notes.length) return ctx.reply('❌ Belum ada note.\n\nBuat dengan: /setnote [nama] [isi]');
    let msg = '📝 *DAFTAR NOTE (' + notes.length + ')*\n' + '─'.repeat(22) + '\n\n';
    notes.forEach(n => { msg += '• `.' + n.nama + '`\n'; });
    msg += '\n_Ketik `.nama` di grup untuk tampilkan._';
    ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔙 Panduan', callback_data: 'guide_note' }]
    ]}});
});

// ==================== AI SETTINGS (MAIN BOT) ====================

bot.command('set_ai_key', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const key = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!key) return ctx.reply(
        '⚙️ *SET AI KEY*\n\nFormat:\n`/set_ai_key [mistral\_api\_key]`\n\nDapat key gratis di:\nhttps://console.mistral.ai',
        { parse_mode: 'Markdown' }
    );
    config.aiKey = key;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    try { await ctx.deleteMessage(); } catch(e) {}
    ctx.reply('✅ AI Key berhasil disimpan!\nAktifkan dengan: /ai\_on');
});

bot.command('set_ai_prompt', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const p = ctx.message.text.split(' ').slice(1).join(' ');
    if (!p) return ctx.reply('Format: /set_ai_prompt [prompt]\nContoh: /set_ai_prompt Kamu adalah asisten toko bernama Mia.', { parse_mode: 'Markdown' });
    config.aiPrompt = p;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ Prompt AI disimpan!', { parse_mode: 'Markdown' });
});

bot.command('ai_on', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ Set API key dulu!\n/set\_ai\_key [key]', { parse_mode: 'Markdown' });
    config.aiEnabled = true;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI diaktifkan untuk chat privat!');
});

bot.command('ai_off', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    config.aiEnabled = false;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI dinonaktifkan.');
});

bot.command('ai_grup_on', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    if (!config.aiKey) return ctx.reply('❌ Set API key dulu!\n/set\_ai\_key [key]', { parse_mode: 'Markdown' });
    config.aiGroupEnabled = true;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI diaktifkan untuk grup!');
});

bot.command('ai_grup_off', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    config.aiGroupEnabled = false;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    ctx.reply('✅ AI grup dinonaktifkan.');
});

bot.command('ai_status', async (ctx) => {
    if (!isAdminOrOwner(ctx.from.id)) return ctx.reply('❌ Akses ditolak!');
    const msg = `🤖 *STATUS AI*\n\n` +
        `🔑 Key: ${config.aiKey ? '✅ Sudah diset' : '❌ Belum diset'}\n` +
        `💬 Private: ${config.aiEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `👥 Grup: ${config.aiGroupEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `🧠 Model: ${config.aiModel || 'mistral-small-latest'}\n\n` +
        `_Perintah: /ai\_on /ai\_off /ai\_grup\_on /ai\_grup\_off_\n` +
        `_/set\_ai\_key /set\_ai\_prompt_`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('owner_ai_settings', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    if (!isOwner(ctx.from.id)) return ctx.reply('❌ Hanya Owner!');
    const msg = `🤖 *AI SETTINGS*\n\n` +
        `🔑 Key: ${config.aiKey ? '✅ Sudah diset' : '❌ Belum diset'}\n` +
        `💬 Private: ${config.aiEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `👥 Grup: ${config.aiGroupEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `🧠 Model: ${config.aiModel || 'mistral-small-latest'}`;
    await safeEditMessage(ctx, msg, {
        reply_markup: { inline_keyboard: [
            [
                { text: config.aiEnabled ? '🔴 AI Private Off' : '🟢 AI Private On', callback_data: 'ai_toggle_private' },
                { text: config.aiGroupEnabled ? '🔴 AI Grup Off' : '🟢 AI Grup On', callback_data: 'ai_toggle_grup' }
            ],
            [{ text: '🔑 Set AI Key (via command)', callback_data: 'ai_key_info' }],
            [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
        ]}
    });
});

bot.action('ai_toggle_private', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    if (!config.aiEnabled && !config.aiKey) {
        return safeAnswerCbQuery(ctx, '❌ Set AI key dulu! Gunakan /set_ai_key', true);
    }
    await safeAnswerCbQuery(ctx);
    config.aiEnabled = !config.aiEnabled;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    // Refresh panel
    const msg = `🤖 *AI SETTINGS*\n\n` +
        `🔑 Key: ${config.aiKey ? '✅ Sudah diset' : '❌ Belum diset'}\n` +
        `💬 Private: ${config.aiEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `👥 Grup: ${config.aiGroupEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `🧠 Model: ${config.aiModel || 'mistral-small-latest'}`;
    await safeEditMessage(ctx, msg, {
        reply_markup: { inline_keyboard: [
            [
                { text: config.aiEnabled ? '🔴 AI Private Off' : '🟢 AI Private On', callback_data: 'ai_toggle_private' },
                { text: config.aiGroupEnabled ? '🔴 AI Grup Off' : '🟢 AI Grup On', callback_data: 'ai_toggle_grup' }
            ],
            [{ text: '🔑 Set AI Key (via command)', callback_data: 'ai_key_info' }],
            [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
        ]}
    });
});

bot.action('ai_toggle_grup', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeAnswerCbQuery(ctx, '❌ Hanya Owner!', true);
    if (!config.aiGroupEnabled && !config.aiKey) {
        return safeAnswerCbQuery(ctx, '❌ Set AI key dulu! Gunakan /set_ai_key', true);
    }
    await safeAnswerCbQuery(ctx);
    config.aiGroupEnabled = !config.aiGroupEnabled;
    fs.writeJsonSync(DB.config, config, { spaces: 2 });
    const msg = `🤖 *AI SETTINGS*\n\n` +
        `🔑 Key: ${config.aiKey ? '✅ Sudah diset' : '❌ Belum diset'}\n` +
        `💬 Private: ${config.aiEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `👥 Grup: ${config.aiGroupEnabled ? '🟢 Aktif' : '🔴 Off'}\n` +
        `🧠 Model: ${config.aiModel || 'mistral-small-latest'}`;
    await safeEditMessage(ctx, msg, {
        reply_markup: { inline_keyboard: [
            [
                { text: config.aiEnabled ? '🔴 AI Private Off' : '🟢 AI Private On', callback_data: 'ai_toggle_private' },
                { text: config.aiGroupEnabled ? '🔴 AI Grup Off' : '🟢 AI Grup On', callback_data: 'ai_toggle_grup' }
            ],
            [{ text: '🔑 Set AI Key (via command)', callback_data: 'ai_key_info' }],
            [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
        ]}
    });
});

bot.action('ai_key_info', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(
        '🔑 *SET AI KEY*\n\nKirim command berikut (key akan otomatis dihapus dari chat):\n\n`/set_ai_key [api\_key\_kamu]`\n\n_Dapat key gratis di: https://console.mistral.ai_',
        { parse_mode: 'Markdown' }
    );
});

// ==================== LAUNCH ====================

bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(() => bot.launch()).then(() => {
    console.log(`✅ ${config.name} v${BOT_VERSION} berjalan!`);
}).catch(err => {
    console.error('❌ Gagal launch:', err.message);
    process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
