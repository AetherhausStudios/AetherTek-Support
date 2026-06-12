require('dotenv').config();

const { Client, Collection, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const STORAGE_DIR = fs.existsSync('/app/storage') ? '/app/storage' : path.join(__dirname, 'data');
const db       = require('./data/db');

// ── HEALTH & ERROR LOG ────────────────────────────────────────────────────────
const LOG_DIR  = path.join(STORAGE_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'hauscall.json');
const LOG_MAX  = 500; // circular buffer cap

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Subsystem health state — updated as events fire
const healthState = {
  discord:    { status: 'starting', lastSeen: null, detail: 'Initialising...' },
  twitch:     { status: 'starting', lastSeen: null, detail: 'Initialising...' },
  monitor:    { status: 'starting', lastSeen: null, detail: 'Initialising...' },
  server:     { status: 'starting', lastSeen: null, detail: 'Initialising...' },
  moderation: { status: 'ok',       lastSeen: null, detail: 'Ready'           },
};

function loadLogs() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}
function saveLogs(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

function hauscallLog(level, subsystem, message) {
  // Always write to console
  if (level === 'error') console.error(`⊹ [${subsystem}] ${message}`);
  else                   console.log(`⊹ [${subsystem}] ${message}`);

  // Write to persistent log store
  const entries = loadLogs();
  entries.unshift({
    id:        Date.now() + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    level,      // 'info' | 'warn' | 'error'
    subsystem,  // 'discord' | 'twitch' | 'monitor' | 'server' | 'moderation' | 'updater'
    message,
  });
  // Trim to cap
  if (entries.length > LOG_MAX) entries.splice(LOG_MAX);
  saveLogs(entries);

  // Update subsystem health
  if (healthState[subsystem]) {
    healthState[subsystem].lastSeen = new Date().toISOString();
    healthState[subsystem].detail   = message.slice(0, 120);
    if (level === 'error') {
      healthState[subsystem].status = 'error';
    } else if (level === 'warn') {
      if (healthState[subsystem].status !== 'error') healthState[subsystem].status = 'warn';
    } else {
      // Info resets error/warn only if it's a positive signal
      if (message.toLowerCase().includes('online') ||
          message.toLowerCase().includes('active') ||
          message.toLowerCase().includes('ready') ||
          message.toLowerCase().includes('loaded') ||
          message.toLowerCase().includes('connected') ||
          message.toLowerCase().includes('success')) {
        healthState[subsystem].status = 'ok';
      }
    }
  }
}

// ── ACTIVITY LOG ─────────────────────────────────────────────────────────────
const ACTIVITY_FILE = path.join(STORAGE_DIR, 'activity.json');
const ACTIVITY_MAX  = 1000;

function loadActivity() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch { return []; }
}
function logActivity(action, detail, meta = {}) {
  const entries = loadActivity();
  entries.unshift({
    id:        Date.now() + Math.random().toString(36).slice(2,5),
    timestamp: new Date().toISOString(),
    action,   // e.g. 'ticket.status', 'ticket.notes', 'monitor.scan', 'config.save'
    detail,   // human-readable description
    meta,     // optional structured data
  });
  if (entries.length > ACTIVITY_MAX) entries.splice(ACTIVITY_MAX);
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(entries, null, 2));
}

// ── STREAMER NOTES ────────────────────────────────────────────────────────────
const NOTES_FILE = path.join(STORAGE_DIR, 'streamer-notes.json');

function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; }
}
function saveNotes(data) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2));
}

// ── HYPE TRAIN STORAGE ───────────────────────────────────────────────────────
const HYPE_TRAIN_FILE = path.join(STORAGE_DIR, 'hype-trains.json');

function loadHypeTrains() {
  try { return JSON.parse(fs.readFileSync(HYPE_TRAIN_FILE, 'utf8')); } catch { return {}; }
}
function saveHypeTrains(data) {
  fs.writeFileSync(HYPE_TRAIN_FILE, JSON.stringify(data, null, 2));
}
function recordHypeTrain(channel, level, contributions) {
  const all = loadHypeTrains();
  if (!all[channel]) all[channel] = [];
  all[channel].push({
    id:            Date.now().toString(36),
    date:          new Date().toISOString(),
    level,
    contributions,
  });
  // Sort by level desc, then date desc
  all[channel].sort((a, b) => b.level !== a.level ? b.level - a.level : new Date(b.date) - new Date(a.date));
  saveHypeTrains(all);
  hauscallLog('info', 'twitch', 'Hype Train recorded for ' + channel + ' — level ' + level + ', ' + contributions + ' contributions');
}

// ── BUSINESS TICKET STORAGE ───────────────────────────────────────────────────
const BUSINESS_DIR = path.join(STORAGE_DIR, 'business');
if (!fs.existsSync(BUSINESS_DIR)) fs.mkdirSync(BUSINESS_DIR, { recursive: true });

const PARTNERSHIP_FILE = path.join(BUSINESS_DIR, 'partnerships.json');
const COMMISSION_FILE  = path.join(BUSINESS_DIR, 'commissions.json');

function loadBusiness(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function saveBusiness(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function genBizId(prefix) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = prefix + '-';
  for (let i = 0; i < 6; i++) id += c[Math.floor(Math.random() * c.length)];
  return id;
}

const BUSINESS_CHANNEL_ID = '1512969490147836025';
const messages = require('./messages');
const twitch   = require('./twitch');

// Monitor loaded with error guard so a crash doesn't take down the bot
let monitor = null;
try {
  monitor = require('./monitor');
  hauscallLog('info','monitor','Discord monitor loaded');
} catch (err) {
  hauscallLog('error','monitor','Discord monitor failed to load: ' + err.message);
}

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CONFIG = {
  token:           process.env.DISCORD_TOKEN,
  clientId:        process.env.CLIENT_ID         || '1500636086983200768',
  guildId:         process.env.GUILD_ID          || '1499916344399757445',
  ticketChannelId: process.env.TICKET_CHANNEL_ID  || '1499916490533765244',
  statsChannelId:  process.env.STATS_CHANNEL_ID   || '1501345238634205246',
  siteUrl:         process.env.SITE_URL           || 'https://aetherhausstudios.github.io/AetherTek-Support',
  port:            process.env.PORT               || 3000,
  internRoleId:    process.env.INTERN_ROLE_ID     || '1501700160290291872',
  rulesMessageId:  process.env.RULES_MESSAGE_ID   || null,
};

// ── TICKET ID GENERATOR ───────────────────────────────────────────────────────
// Hauscall owns ID generation — never trust the client to mint these.

function genTicketId(prefix = 'TKT') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = `${prefix}-`;
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  // Ensure uniqueness — regenerate if already exists
  if (db.getTicket(id)) return genTicketId(prefix);
  return id;
}

// ── BOT CLIENT ────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ]
});

// ── LOAD COMMANDS ─────────────────────────────────────────────────────────────

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// Expose config to commands via client
client.config = CONFIG;

// ── READY ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async c => {
  hauscallLog('info','discord','Hauscall online — logged in as ' + c.user.tag);
  // Run retrospective scan after 15s — gives guild cache time to populate
  setTimeout(async () => {
    if (monitor) {
      hauscallLog('info','monitor','Running startup retro scan (48hr window)');
      await monitor.retroScanAll(client).catch(err =>
        hauscallLog('error','monitor','Retro scan error: ' + err.message)
      );
    }
  }, 15000);
  hauscallLog('info','discord','Watching ' + c.guilds.cache.size + ' server(s)');
  hauscallLog('info','server','Receiver listening on port ' + CONFIG.port);
  scheduleDailyStats();

  // Init Twitch integration
  const pendingPulses = [];
  await twitch.init(
    (channel, { username, message }) => {
      hauscallLog('info','twitch','Trigger word in #' + channel + ' from ' + username);
      pendingPulses.push({ channel, username, message, timestamp: new Date().toISOString() });
    },
    (channel, liveData) => {
      hauscallLog('info','twitch',channel + ' is now ' + (liveData ? 'LIVE' : 'offline'));
    }
  );

  // ── AUTO-POST: register session-end callback ──────────────────────────────
  // When a Twitch session ends, check if auto-post is configured for that
  // channel and post the transcript to Discord if so.
  twitch.onSessionEnd(async (channel, session) => {
    const settings = db.getTranscriptPostSettings() || {};
    const cfg      = settings[channel];
    if (!cfg?.autoPost || !cfg.guildId || !cfg.channelId) return;

    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) {
      hauscallLog('warn','discord','Auto-post: guild ' + cfg.guildId + ' not found for #' + channel);
      return;
    }
    const discordChannel = guild.channels.cache.get(cfg.channelId);
    if (!discordChannel) {
      hauscallLog('warn','discord','Auto-post: channel ' + cfg.channelId + ' not found in ' + guild.name);
      return;
    }

    try {
      const { AttachmentBuilder } = require('discord.js');
      const messages = session.messages || [];
      const dateLabel = new Date(session.startTime).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', year:'numeric' });

      const lines  = messages.map(m => {
        const ts = new Date(m.timestamp).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone:'America/Chicago' });
        return `[${ts}] ${m.username}: ${m.message}`;
      });
      const header = [
        'AetherTek Chat Transcript',
        `Channel: ${channel}`,
        `Date: ${dateLabel}`,
        `Messages: ${messages.length}`,
        `Session ID: ${session.id}`,
        'Timestamps: CST (America/Chicago)',
        `Duration: ${session.endTime ? Math.round((new Date(session.endTime) - new Date(session.startTime)) / 60000) + ' min' : 'unknown'}`,
        `Posted: ${new Date().toLocaleString('en-US', { timeZone:'America/Chicago', dateStyle:'medium', timeStyle:'short' })} CST`,
        'Auto-posted: Yes',
        '─────────────────────────────────────',
        '',
      ].join('\n');

      // Include violations and watched reports (written async after session end)
      let violationsReport = '';
      let watchedReport    = '';
      let confirmedCount   = 0;
      let reviewCount      = 0;
      let watchedCount     = 0;
      try {
        const sessionFile = path.join(STORAGE_DIR, 'transcripts', `${session.id}.json`);
        if (fs.existsSync(sessionFile)) {
          const fresh = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
          violationsReport = fresh.violationsReport || '';
          watchedReport    = fresh.watchedReport    || '';
          watchedCount     = fresh.watchedMessages?.length || 0;
          confirmedCount   = fresh.claudeFlags?.confirmed?.length || 0;
          reviewCount      = fresh.claudeFlags?.review?.length    || 0;
          const rtConfirmed = (fresh.realTimeFlags || []).filter(f => f.flags.some(fl => fl.severity === 'confirmed')).length;
          confirmedCount  += rtConfirmed;
        }
      } catch {}

      const fullText   = header + lines.join('\n') +
        (violationsReport ? '\n' + violationsReport : '') +
        (watchedReport    ? '\n' + watchedReport    : '');
      const buf        = Buffer.from(fullText, 'utf8');
      const attachment = new AttachmentBuilder(buf, { name: `transcript_${channel}_${session.id}.txt` });

      const flagSummary = confirmedCount || reviewCount
        ? `\n**Flags:** ${confirmedCount} confirmed · ${reviewCount} for review`
        : '\n**Flags:** None raised';

      hauscallLog('info','discord','Auto-posted transcript: ' + channel + ' (' + messages.length + ' messages, ' + confirmedCount + ' flags)');
    } catch (err) {
      hauscallLog('error','discord','Auto-post failed for ' + channel + ': ' + err.message);
    }
  });

  // GET /streams/pulses — return and clear pending pulses
  // (added inline here so it has access to pendingPulses closure)
  global._getPendingPulses = () => {
    const pulses = [...pendingPulses];
    pendingPulses.length = 0;
    return pulses;
  };
});

// ── REACTION ROLES ────────────────────────────────────────────────────────────
// Assigns the Intern role when a member reacts with ⊹ on the rules message.

// ── DISCORD CHANNEL MONITOR ───────────────────────────────────────────────────
// Watches configured channels for AI art, self-promotion, and sensitive topics.
// Config managed via AetherhausDesk. Alerts posted to configured mod channel.

client.on(Events.MessageCreate, async message => {
  if (!monitor) return;
  // Check for message flood raid pattern
  if (!message.author.bot && message.guild) {
    const raidAccounts = monitor.trackMessage(message.guild.id, message);
    if (raidAccounts) {
      await monitor.postRaidAlert(client, message.guild.id,
        'Message flood from new accounts',
        '8+ messages from new/unverified accounts within 10 seconds',
        raidAccounts
      ).catch(err => hauscallLog('error','monitor','Raid alert error: ' + err.message));
    }
  }
  monitor.handleMessage(client, message).catch(err => {
    hauscallLog('error','monitor','Monitor error: ' + err.message);
  });
});

// Raid detection — join spike
client.on(Events.GuildMemberAdd, async member => {
  if (!monitor) return;

  // Check for raid pattern first
  const raidAccounts = monitor.trackJoin(member.guild.id, member);
  if (raidAccounts) {
    await monitor.postRaidAlert(client, member.guild.id,
      'Join spike from new/unverified accounts',
      '5+ suspicious accounts joined within 30 seconds',
      raidAccounts
    ).catch(err => hauscallLog('error','monitor','Raid join alert error: ' + err.message));
    return; // Raid alert covers this member — no need for solo alert too
  }

  // Solo bot detection — score this individual account
  const { score, reasons } = monitor.scoreSuspicion(member);
  if (score >= monitor.BOT_SCORE_THRESHOLD) {
    await monitor.postSoloBotAlert(client, member.guild.id, member, score, reasons)
      .catch(err => hauscallLog('error','monitor','Solo bot alert error: ' + err.message));
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (!CONFIG.rulesMessageId) return;
  if (reaction.message.id !== CONFIG.rulesMessageId) return;
  if (reaction.emoji.name !== '🔮') return;

  try {
    const guild  = await client.guilds.fetch(CONFIG.guildId);
    const member = await guild.members.fetch(user.id);
    if (member.roles.cache.has(CONFIG.internRoleId)) return; // already has role
    await member.roles.add(CONFIG.internRoleId);
    hauscallLog('info','discord','Assigned Intern role to ' + user.tag);
  } catch (err) {
    hauscallLog('error','discord','Reaction role error: ' + err.message);
  }
});

// ── PUBLIC WEEKLY DIGEST ─────────────────────────────────────────────────────
// Generates every Sunday at 10am CST. Public-facing metrics snapshot —
// no streamer names, no server names, no ticket or business data.

const DIGEST_FILE = path.join(STORAGE_DIR, 'public-digest.json');

function msUntilNextSunday10amCST() {
  const now  = new Date();
  const next = new Date();
  // Get current UTC day — Sunday 10am CST = Sunday 16:00 UTC
  const dayUTC = now.getUTCDay(); // 0=Sun
  const daysUntilSunday = dayUTC === 0 && now.getUTCHours() < 16 ? 0 : (7 - dayUTC) % 7 || 7;
  next.setUTCDate(now.getUTCDate() + daysUntilSunday);
  next.setUTCHours(16, 0, 0, 0);
  return next - now;
}

function generatePublicDigest() {
  try {
    const tDir   = path.join(STORAGE_DIR, 'transcripts');
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let sessions = 0, messages = 0, flags = 0;

    if (fs.existsSync(tDir)) {
      fs.readdirSync(tDir).forEach(file => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(tDir, file), 'utf8'));
          if (data.startTime < cutoff) return;
          sessions++;
          messages += data.messageCount || (data.messages || []).length;
          const summary = data.moderationSummary || {};
          flags += (summary.confirmed || []).length + (summary.review || []).length;
        } catch {}
      });
    }

    // Discord monitor alerts from past 7 days
    const monCfg = monitor ? monitor.loadConfig() : {};
    let discordAlerts = 0;
    Object.keys(monCfg).forEach(guildId => {
      const alerts = monitor ? monitor.getAlerts(guildId, 1000) : [];
      discordAlerts += (alerts || []).filter(a => a.timestamp > cutoff).length;
    });

    const digest = {
      generatedAt:  new Date().toISOString(),
      weekOf:       cutoff.slice(0, 10),
      streams:      { sessions, messages, flags },
      discord:      { alertsFired: discordAlerts },
    };

    fs.writeFileSync(DIGEST_FILE, JSON.stringify(digest, null, 2));
    hauscallLog('info', 'server', 'Weekly public digest generated — ' + sessions + ' sessions, ' + messages + ' messages, ' + flags + ' flags, ' + discordAlerts + ' discord alerts');
  } catch (err) {
    hauscallLog('error', 'server', 'Weekly digest generation failed: ' + err.message);
  }
}

(function scheduleWeeklyDigest() {
  const delay = msUntilNextSunday10amCST();
  hauscallLog('info', 'server', 'Weekly digest scheduled — next generation in ' + Math.round(delay / 1000 / 60) + ' minutes');
  setTimeout(() => {
    generatePublicDigest();
    setInterval(generatePublicDigest, 7 * 24 * 60 * 60 * 1000);
  }, delay);
})();

function scheduleDailyStats() {
  // Post at 16:00 UTC (10am CST / 11am CDT)
  function msUntilNext10amCST() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(16, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  setTimeout(async () => {
    await postDailyStats();
    setInterval(postDailyStats, 24 * 60 * 60 * 1000);
  }, msUntilNext10amCST());

  hauscallLog('info','discord','Daily stats scheduled — next post in ' + Math.round(msUntilNext10amCST() / 1000 / 60) + ' minutes');
}

async function postDailyStats() {
  try {
    const guild   = await client.guilds.fetch(CONFIG.guildId);
    const channel = await guild.channels.fetch(CONFIG.statsChannelId);
    if (!channel) return;

    // Yesterday's window
    const now       = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday);
    yesterdayEnd.setUTCHours(23, 59, 59, 999);

    const allTickets  = db.getAllTickets();
    const yesterdayNew      = allTickets.filter(t => {
      const d = new Date(t.createdAt);
      return d >= yesterday && d <= yesterdayEnd;
    });
    const yesterdayResolved = allTickets.filter(t => {
      if (!t.resolvedAt) return false;
      const d = new Date(t.resolvedAt);
      return d >= yesterday && d <= yesterdayEnd;
    });

    // Current queue snapshot
    const stats   = db.getStats();
    const open    = db.getOpenTickets();
    const onFire  = open.filter(t => t.urgency === 'high').length;
    const burning = open.filter(t => t.urgency === 'med').length;
    const chill   = open.filter(t => t.urgency === 'low').length;
    const critical= open.filter(t => t.urgency === 'critical').length;

    // Tips
    const tips     = db.getTips();
    const tipTotal = tips.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

    const starStr = stats.averageRating
      ? '★'.repeat(Math.round(stats.averageRating)) + '☆'.repeat(5 - Math.round(stats.averageRating)) + ` (${stats.averageRating})`
      : 'No ratings yet';

    const yesterdayLabel = yesterday.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    const embed = new EmbedBuilder()
      .setTitle('⊹ Daily Aetherhaus Report')
      .setColor(0x7c4daa)
      .setDescription(`*Morning summary for ${yesterdayLabel}*`)
      .addFields(
        {
          name: `📅 Yesterday`,
          value: yesterdayNew.length || yesterdayResolved.length ? [
            yesterdayNew.length      ? `Tickets received: **${yesterdayNew.length}**`      : null,
            yesterdayResolved.length ? `Tickets resolved: **${yesterdayResolved.length}**` : null,
          ].filter(Boolean).join('\n') : '*A quiet day. The chaos rested.*',
          inline: true,
        },
        {
          name: '📋 Current Queue',
          value: [
            `Open: **${stats.openCount}**`,
            critical ? `🚨 Critical: **${critical}**` : null,
            onFire   ? `🔥 On Fire: **${onFire}**`   : null,
            burning  ? `🕯 Burning: **${burning}**`   : null,
            chill    ? `🌿 Chill: **${chill}**`       : null,
            !stats.openCount ? '*The queue is clear.*' : null,
          ].filter(Boolean).join('\n'),
          inline: true,
        },
        {
          name: '📊 All Time',
          value: [
            `Total tickets: **${stats.total}**`,
            `Resolved: **${stats.resolvedCount}**`,
            `Resolution rate: **${stats.resolutionRate}%**`,
            `Average rating: **${starStr}**`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '☕ Tips',
          value: tips.length
            ? `**$${tipTotal.toFixed(2)}** received across **${tips.length}** tip${tips.length !== 1 ? 's' : ''}`
            : 'No tips logged yet',
          inline: false,
        },
      )
      .setFooter({ text: 'Hauscall · Chaos Managed. Probably.' });

    await channel.send({ embeds: [embed] });
    hauscallLog('info','discord','Daily stats posted');
  } catch (err) {
    hauscallLog('error','discord','Daily stats error: ' + err.message);
  }
}

// ── SLASH COMMAND HANDLER ─────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    hauscallLog('error','discord','Error executing /' + interaction.commandName + ': ' + err.message);
    const msg = { content: '⚠️ Something went wrong. Check the console.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ── HTTP RECEIVER ─────────────────────────────────────────────────────────────
// Forms POST here. Desktop app uses authenticated GET/PATCH endpoints.

const API_KEY = process.env.API_KEY || 'ChaosManageProbably';

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function isAuthenticated(req) {
  const key = req.headers['x-api-key'];
  return key === API_KEY;
}

// Returns the pre-buffered request body as parsed JSON.
// Body is buffered once at the top of the request handler into _rawBody.
function getBody(rawBody) {
  try { return JSON.parse(rawBody); }
  catch { return null; }
}

const server = http.createServer(async (req, res) => {
  // CORS — allow all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Buffer the full request body upfront for all POST/PATCH requests.
  let _rawBody = '';
  if (req.method === 'POST' || req.method === 'PATCH') {
    await new Promise((resolve, reject) => {
      // Guard: if stream already ended (keep-alive reuse), resolve immediately
      if (req.readableEnded) { resolve(); return; }
      const onData  = chunk => { _rawBody += chunk; };
      const onEnd   = () => { cleanup(); resolve(); };
      const onError = e  => { cleanup(); reject(e); };
      const cleanup = () => {
        req.removeListener('data',  onData);
        req.removeListener('end',   onEnd);
        req.removeListener('error', onError);
      };
      req.on('data',  onData);
      req.on('end',   onEnd);
      req.on('error', onError);
      // Safety timeout — if end never fires, resolve with whatever we have
      setTimeout(() => { cleanup(); resolve(); }, 5000);
    });
  }

  // ── PUBLIC ROUTES (no auth needed) ──────────────────────────────────────────

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    return json(res, 200, { status: 'ok', name: 'Hauscall', uptime: process.uptime() });
  }

  // Debug — check auth state (remove after diagnosis)
  if (req.method === 'GET' && req.url === '/debug/auth') {
    const key = req.headers['x-api-key'];
    return json(res, 200, {
      authenticated: isAuthenticated(req),
      keyPresent:    !!key,
      keyPreview:    key ? key.slice(0,4) + '...' : null,
      apiKeySet:     !!API_KEY,
      apiKeyPreview: API_KEY ? API_KEY.slice(0,4) + '...' : null,
    });
  }

  // Ko-fi webhook — form-encoded, handled separately before JSON POST block
  if (req.method === 'POST' && req.url === '/kofi') {
    const body = _rawBody;
    try {
        const params = new URLSearchParams(body);
        const raw    = params.get('data');
        if (!raw) return json(res, 400, { error: 'No data' });

        const data = JSON.parse(raw);

        // Verify token
        const KOFI_TOKEN = process.env.KOFI_TOKEN || '20898124-7b91-4f07-88ae-d5bef84b6add';
        if (data.verification_token !== KOFI_TOKEN) {
          console.warn('Ko-fi webhook: invalid token.');
          return json(res, 401, { error: 'Invalid token' });
        }

        // Only log tips and subscriptions
        if (data.type !== 'Donation' && data.type !== 'Subscription') {
          return json(res, 200, { ok: true, ignored: true });
        }

        const amount   = parseFloat(data.amount) || 0;
        const currency = data.currency  || 'USD';
        const name     = data.from_name || 'Anonymous';
        const message  = data.message   || '';
        const isPublic = data.is_public;

        // Log to tip database
        db.addTip({
          amount,
          platform: 'Ko-fi',
          note: message
            ? `${name}${isPublic ? '' : ' (private)'}: ${message}`
            : `${name}${isPublic ? '' : ' (private)'}`,
        });

        // Post to ticket channel
        const channel = await getTicketChannel();
        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle('☕ New Ko-fi Tip')
            .setColor(0xFF5E5B)
            .addFields(
              { name: 'From',   value: name,                                inline: true },
              { name: 'Amount', value: `${currency} $${amount.toFixed(2)}`, inline: true },
              { name: 'Type',   value: data.type,                           inline: true },
              ...(message ? [{ name: 'Message', value: message }] : []),
            )
            .setFooter({ text: 'Ko-fi · ' + new Date().toLocaleString() });
          await channel.send({ embeds: [embed] });
        }

        hauscallLog('info','server','Ko-fi tip: $' + amount + ' from ' + name);
        return json(res, 200, { ok: true });
      } catch (err) {
        hauscallLog('error','server','Ko-fi webhook error: ' + err.message);
        return json(res, 400, { error: 'Invalid payload' });
      }
      return;
    }

  // ── AUTHENTICATED STREAM POST ROUTES (must come before general POST block) ──

  if (req.method === 'POST' && req.url === '/streams/add' && isAuthenticated(req)) {
    const body = _rawBody;
    try {
        const { username } = JSON.parse(body);
        if (!username) return json(res, 400, { error: 'Username required' });
        const result = await twitch.addStreamer(username);
        return json(res, result.error ? 400 : 200, result);
      } catch (err) {
        hauscallLog('error','server','streams/add error: ' + (err.message||err));
        return json(res, 400, { error: err.message || 'Invalid request' });
      }
      return;
    }

  if (req.method === 'POST' && req.url === '/streams/remove' && isAuthenticated(req)) {
    const body = _rawBody;
    try {
        const { username } = JSON.parse(body);
        return json(res, 200, twitch.removeStreamer(username));
      } catch { return json(res, 400, { error: 'Invalid request' }); }
      return;
    }

  if (req.method === 'PATCH' && req.url === '/streams/triggers' && isAuthenticated(req)) {
    const body = _rawBody;
    try {
        const { words } = JSON.parse(body);
        twitch.setTriggerWords(words);
        return json(res, 200, { ok: true, words });
      } catch { return json(res, 400, { error: 'Invalid request' }); }
      return;
    }

  if (req.method === 'POST' && req.url === '/tips' && isAuthenticated(req)) {
    const body = _rawBody;
    try {
        const { amount, platform, note } = JSON.parse(body);
        if (!amount) return json(res, 400, { error: 'Amount is required' });
        db.addTip({ amount, platform: platform || 'Unknown', note: note || '' });
        return json(res, 200, { ok: true });
      } catch { return json(res, 400, { error: 'Invalid request' }); }
      return;
    }

  // Form submission routes (public — called from GitHub Pages forms)
  if (req.method === 'POST') {
    const body = _rawBody;

    // ── BUSINESS TICKET ROUTES (public, no auth) ─────────────────────────────
    if (req.url === '/partnership') {
      try {
        const data = JSON.parse(body || '{}');
        const id   = genBizId('PRT');
        const record = {
          id, type: 'partnership', status: 'pending',
          discord: data.discord || 'unknown', server: data.server || 'unknown',
          twitch:  data.twitch  || '',        size:   data.size   || '',
          why:     data.why     || '',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), notes: '',
        };
        const all = loadBusiness(PARTNERSHIP_FILE);
        all.unshift(record);
        saveBusiness(PARTNERSHIP_FILE, all);
        const bCh = client.channels.cache.get(BUSINESS_CHANNEL_ID);
        if (bCh) {
          const { EmbedBuilder } = require('discord.js');
          await bCh.send({ embeds: [new EmbedBuilder().setColor(0x0d9488)
            .setTitle(`⊹ ${id} — Partnership Application`)
            .addFields(
              { name: 'Discord',        value: data.discord || 'unknown', inline: true },
              { name: 'Server',         value: data.server  || 'unknown', inline: true },
              { name: 'Twitch',         value: data.twitch  || 'none',    inline: true },
              { name: 'Community Size', value: data.size    || 'unknown', inline: true },
              { name: 'Application',    value: (data.why    || '').slice(0, 1024) },
            ).setFooter({ text: 'AetherTek Partnership · ' + new Date().toLocaleString() })] });
        }
        json(res, 200, { ok: true, id });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    if (req.url === '/commission') {
      try {
        const data = JSON.parse(body || '{}');
        const isBusiness = data.isBusiness || false;
        const prefix = isBusiness ? 'BIZ' : 'COM';
        const id     = genBizId(prefix);
        const record = {
          id, type: isBusiness ? 'business' : 'commission', status: 'pending',
          discord:  data.discord  || 'unknown', projType: data.projType || '',
          timeline: data.timeline || '',        desc:     data.desc     || '',
          extra:    data.extra    || '',        isBusiness,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), notes: '',
        };
        const all = loadBusiness(COMMISSION_FILE);
        all.unshift(record);
        saveBusiness(COMMISSION_FILE, all);
        const bCh = client.channels.cache.get(BUSINESS_CHANNEL_ID);
        if (bCh) {
          const { EmbedBuilder } = require('discord.js');
          const color = isBusiness ? 0xc4962a : 0x7c4daa;
          const title = isBusiness
            ? `🏢 ${id} — Business Project Brief`
            : `✦ ${id} — Project Commission Brief`;
          await bCh.send({ embeds: [new EmbedBuilder().setColor(color)
            .setTitle(title)
            .addFields(
              { name: 'Discord',      value: data.discord  || 'unknown', inline: true },
              { name: 'Project Type', value: data.projType || 'unknown', inline: true },
              { name: 'Timeline',     value: data.timeline || 'unknown', inline: true },
              { name: 'Description',  value: (data.desc    || '').slice(0, 1024) },
              { name: 'Additional',   value: (data.extra   || 'none').slice(0, 512) },
            ).setFooter({ text: (isBusiness ? 'AetherTek Business Project' : 'AetherTek Commission') + ' · ' + new Date().toLocaleString() })] });
        }
        json(res, 200, { ok: true, id });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    // Public intake routes — ticket/review/hardware/report
    // All other POSTs fall through to authenticated route handlers below
    if (['/ticket', '/review', '/hardware', '/report'].includes(req.url)) {
      try {
        const data = JSON.parse(body);
        if      (req.url === '/ticket')   await handleTicket(data, res);
        else if (req.url === '/review')   await handleReview(data, res);
        else if (req.url === '/hardware') await handleHardware(data, res);
        else if (req.url === '/report')   await handleReport(data, res);
      } catch (err) {
        hauscallLog('error','server','Receiver error: ' + (err.message||err));
        json(res, 400, { error: 'Invalid request' });
      }
      return;
    }
    // All other POSTs continue to authenticated route handlers below
  }

  // ── AUTHENTICATED ROUTES (desktop app only) ──────────────────────────────────

  if (!isAuthenticated(req)) {
    return json(res, 401, { error: 'Unauthorised' });
  }

  // GET /queue — all open tickets in priority order
  if (req.method === 'GET' && req.url === '/queue') {
    return json(res, 200, { tickets: db.getOpenTickets() });
  }

  // GET /ticket/:id
  const ticketMatch = req.url.match(/^\/ticket\/([A-Z0-9-]+)$/);
  if (req.method === 'GET' && ticketMatch) {
    const ticket = db.getTicket(ticketMatch[1]);
    if (!ticket) return json(res, 404, { error: 'Not found' });
    const review  = db.getReviewForTicket(ticketMatch[1]);
    const summary = db.getSubmitterSummary(ticket.discord);
    return json(res, 200, { ticket, review, submitterSummary: summary });
  }

  // GET /archive?q=searchterm — search all tickets across all statuses
  if (req.method === 'GET' && req.url.startsWith('/archive')) {
    const urlParams = new URL(req.url, 'http://localhost');
    const query     = urlParams.searchParams.get('q') || '';
    const handle    = urlParams.searchParams.get('handle') || '';
    const tickets   = handle
      ? db.getTicketsByHandle(handle)
      : db.searchTickets(query);
    return json(res, 200, { tickets, query: query || handle, total: tickets.length });
  }

  // PATCH /ticket/:id/notes — save internal notes
  const notesMatch = req.url.match(/^\/ticket\/([A-Z0-9-]+)\/notes$/);
  if (req.method === 'PATCH' && notesMatch) {
    const body = _rawBody;
    try {
        const { notes } = JSON.parse(body);
        const ticketId  = notesMatch[1];
        const ok = db.updateNotes(ticketId, notes);
        if (!ok) return json(res, 404, { error: 'Not found' });
        return json(res, 200, { ok: true, ticketId });
      } catch {
        return json(res, 400, { error: 'Invalid request' });
      }
      return;
    }

  // PATCH /ticket/:id/urgency — escalate urgency
  const urgencyMatch = req.url.match(/^\/ticket\/([A-Z0-9-]+)\/urgency$/);
  if (req.method === 'PATCH' && urgencyMatch) {
    const body = _rawBody;
    try {
        const { urgency } = JSON.parse(body);
        const ticketId    = urgencyMatch[1];
        const ok = db.updateTicket(ticketId, { urgency });
        if (!ok) return json(res, 404, { error: 'Not found' });
        return json(res, 200, { ok: true, ticketId, urgency });
      } catch { return json(res, 400, { error: 'Invalid request' }); }
      return;
    }
  const patchMatch = req.url.match(/^\/ticket\/([A-Z0-9-]+)\/status$/);
  if (req.method === 'PATCH' && patchMatch) {
    const body = _rawBody;
    try {
        const { status, reason } = JSON.parse(body);
        const ticketId = patchMatch[1];
        const ticket   = db.getTicket(ticketId);
        if (!ticket) return json(res, 404, { error: 'Not found' });

        db.updateTicket(ticketId, {
          status,
          ...(reason ? { closeReason: reason } : {}),
          [`${status}At`]: new Date().toISOString()
        });
        logActivity('ticket.status', 'Ticket ' + ticketId + ' status → ' + status, { id: ticketId, status, discord: ticket.discord });

        // Trigger appropriate DM
        if (ticket.notify && ticket.discordId) {
          try {
            const user = await client.users.fetch(ticket.discordId);
            if (status === 'reviewing') await user.send(messages.dmReviewBegun(ticketId));
            if (status === 'resolved')  await user.send(messages.dmResolved(ticketId));
          } catch {
            console.warn(`Could not DM ${ticket.discord} after status update.`);
          }
        }

        return json(res, 200, { ok: true, ticketId, status });
      } catch (err) {
        return json(res, 400, { error: 'Invalid request' });
      }
      return;
    }

  // GET /tips — full tip ledger
  if (req.method === 'GET' && req.url === '/tips') {
    return json(res, 200, { tips: db.getTips() });
  }

  // DELETE /tips/:id — remove a tip entry
  const tipMatch = req.url.match(/^\/tips\/(\d+)$/);
  if (req.method === 'DELETE' && tipMatch) {
    db.deleteTip(tipMatch[1]);
    return json(res, 200, { ok: true });
  }

  // GET /stats — summary metrics for the dashboard
  if (req.method === 'GET' && req.url === '/stats') {
    const stats = db.getStats();
    return json(res, 200, {
      ...stats,
      serverCount: client.guilds.cache.size,
    });
  }

  // ── STREAM ENDPOINTS ────────────────────────────────────────────────────────

  // GET /streams — all monitored streamers with live status
  if (req.method === 'GET' && req.url === '/streams') {
    return json(res, 200, { streamers: twitch.getStreamers(), triggerWords: twitch.getTriggerWords() });
  }

  // PATCH /streams/:username/guild — link a streamer to a Discord guild
  if (req.method === 'PATCH' && req.url.match(/^\/streams\/[^/]+\/guild$/) && isAuthenticated(req)) {
    const username  = req.url.split('/')[2].toLowerCase();
    const { guildId } = JSON.parse(_rawBody || '{}');
    const result    = twitch.setStreamerGuild(username, guildId || null);
    if (!result) return json(res, 404, { error: 'Streamer not found' });
    logActivity('streamer.guild', 'Linked ' + username + ' to guild ' + (guildId || 'none'), { username, guildId });
    return json(res, 200, { ok: true });
  }

  // GET /streams/pulses — pending trigger word detections
  if (req.method === 'GET' && req.url === '/streams/pulses') {
    const pulses = global._getPendingPulses ? global._getPendingPulses() : [];
    return json(res, 200, { pulses });
  }

  // ── TRANSCRIPT ENDPOINTS ─────────────────────────────────────────────────────

  // GET /transcripts/:channel — list sessions for a channel
  const transcriptListMatch = req.url.match(/^\/transcripts\/([a-zA-Z0-9_]+)$/);
  if (req.method === 'GET' && transcriptListMatch) {
    const sessions = twitch.getTranscriptSessions(transcriptListMatch[1].toLowerCase());
    return json(res, 200, { sessions });
  }

  // GET /transcripts/:channel/:sessionId — full session log
  const transcriptSessionMatch = req.url.match(/^\/transcripts\/([a-zA-Z0-9_]+)\/(.+)$/);
  if (req.method === 'GET' && transcriptSessionMatch) {
    const session = twitch.getTranscriptSession(transcriptSessionMatch[2]);
    if (!session) return json(res, 404, { error: 'Session not found' });
    return json(res, 200, { session });
  }

  // GET /transcripts/search?channel=x&q=y — search across transcripts
  if (req.method === 'GET' && req.url.startsWith('/transcripts/search')) {
    const urlParams = new URL(req.url, 'http://localhost');
    const channel   = urlParams.searchParams.get('channel') || '';
    const query     = urlParams.searchParams.get('q') || '';
    if (!query) return json(res, 400, { error: 'Query required' });
    const results = twitch.searchTranscripts(channel, query);
    return json(res, 200, { results, query, channel });
  }

  // ── DISCORD TRANSCRIPT POSTING ────────────────────────────────────────────

  // GET /discord/guilds — all guilds Hauscall is in, with their text channels
  // Used by AetherhausDesk to populate the guild + channel selectors
  if (req.method === 'GET' && req.url === '/discord/guilds' && isAuthenticated(req)) {
    const guilds = [];
    for (const [guildId, guild] of client.guilds.cache) {
      const channels = [];
      guild.channels.cache
        .filter(ch => ch.type === 0) // 0 = GUILD_TEXT
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .forEach(ch => channels.push({ id: ch.id, name: ch.name, topic: ch.topic || '' }));
      guilds.push({ id: guildId, name: guild.name, icon: guild.iconURL({ dynamic: true, size: 64 }) || null, channels });
    }
    return json(res, 200, { guilds });
  }

  // ── MODERATION RULESET API ────────────────────────────────────────────────

  // ── DISCORD MONITOR API ───────────────────────────────────────────────────

  // GET /monitor/config — all guild configs
  if (req.method === 'GET' && req.url === '/monitor/config' && isAuthenticated(req)) {
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    return json(res, 200, { config: monitor.loadConfig() });
  }

  // GET /monitor/config/:guildId — config for one guild
  if (req.method === 'GET' && req.url.startsWith('/monitor/config/') && !req.url.includes('/alerts') && isAuthenticated(req)) {
    const guildId = req.url.split('/monitor/config/')[1];
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    const cfg     = monitor.getGuildConfig(guildId);
    return json(res, cfg ? 200 : 404, cfg || { error: 'No config for this guild' });
  }

  // POST /monitor/config/:guildId — save config for one guild
  // Body: { alertChannelId, watchedChannels: [id,...] }
  if (req.method === 'POST' && req.url.startsWith('/monitor/config/') && isAuthenticated(req)) {
    const guildId = req.url.split('/monitor/config/')[1];
    const parsed  = getBody(_rawBody);
    if (!parsed) return json(res, 400, { error: 'Invalid body' });
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    const updated = monitor.setGuildConfig(guildId, {
      alertChannelId:  parsed.alertChannelId,
      watchedChannels: parsed.watchedChannels || [],
      modRoleId:       parsed.modRoleId || null,
    });
    return json(res, 200, { ok: true, config: updated });
  }

  // GET /monitor/check/:guildId — check Hauscall's permissions in configured channels
  if (req.method === 'GET' && req.url.startsWith('/monitor/check/') && isAuthenticated(req)) {
    const guildId = req.url.split('/monitor/check/')[1];
    const cfg     = monitor ? monitor.getGuildConfig(guildId) : null;
    if (!cfg) return json(res, 404, { error: 'No config for this guild' });

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return json(res, 404, { error: 'Guild not found' });

    const me = guild.members.me;
    const results = { alertChannel: null, watchedChannels: [] };

    // Check alert channel
    if (cfg.alertChannelId) {
      const ch = guild.channels.cache.get(cfg.alertChannelId);
      if (!ch) {
        results.alertChannel = { id: cfg.alertChannelId, name: null, canView: false, canSend: false, canEmbed: false, error: 'Channel not found' };
      } else {
        const perms = ch.permissionsFor(me);
        results.alertChannel = {
          id:       cfg.alertChannelId,
          name:     ch.name,
          canView:  perms.has('ViewChannel'),
          canSend:  perms.has('SendMessages'),
          canEmbed: perms.has('EmbedLinks'),
          ok:       perms.has('ViewChannel') && perms.has('SendMessages') && perms.has('EmbedLinks'),
        };
      }
    }

    // Check watched channels
    for (const channelId of (cfg.watchedChannels || [])) {
      const ch = guild.channels.cache.get(channelId);
      if (!ch) {
        results.watchedChannels.push({ id: channelId, name: null, canRead: false, error: 'Channel not found' });
      } else {
        const perms = ch.permissionsFor(me);
        results.watchedChannels.push({
          id:      channelId,
          name:    ch.name,
          canRead: perms.has('ViewChannel') && perms.has('ReadMessageHistory'),
          ok:      perms.has('ViewChannel') && perms.has('ReadMessageHistory'),
        });
      }
    }

    return json(res, 200, results);
  }

  // ── PUBLIC DIGEST ENDPOINT ───────────────────────────────────────────────────
  // Returns anonymised weekly stats for the public support site digest page.
  // No streamer names, server names, ticket data, or business activity.

  if (req.method === 'GET' && req.url === '/digest') {
    try {
      const now     = Date.now();
      const week    = 7 * 24 * 60 * 60 * 1000;
      const weekAgo = new Date(now - week).toISOString();

      // ── Transcript stats ──────────────────────────────────────────────────
      const tDir = path.join(STORAGE_DIR, 'transcripts');
      let sessionCount   = 0;
      let totalMessages  = 0;
      let totalFlags     = 0;

      if (fs.existsSync(tDir)) {
        const files = fs.readdirSync(tDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const session = JSON.parse(fs.readFileSync(path.join(tDir, file), 'utf8'));
            // Only count sessions that ended within the past week
            const endTime = session.endTime || session.startTime;
            if (endTime && endTime > weekAgo) {
              sessionCount++;
              totalMessages += session.messageCount || (session.messages || []).length || 0;
              // Count confirmed flags from moderation summary
              if (session.moderationSummary) {
                totalFlags += (session.moderationSummary.confirmed || []).length;
                totalFlags += (session.moderationSummary.review    || []).length;
              }
            }
          } catch { /* skip malformed */ }
        }
      }

      // ── Discord alert stats ───────────────────────────────────────────────
      const monitorCfg  = monitor ? monitor.loadConfig() : {};
      let   discordAlerts = 0;

      for (const guildId of Object.keys(monitorCfg)) {
        try {
          const alerts = monitor ? monitor.getAlerts(guildId, 1000) : [];
          discordAlerts += (alerts.alerts || []).filter(a =>
            a.timestamp && a.timestamp > weekAgo
          ).length;
        } catch { /* skip */ }
      }

      // ── Build digest ──────────────────────────────────────────────────────
      const digest = {
        generatedAt:   new Date().toISOString(),
        period:        'Last 7 days',
        periodStart:   weekAgo,
        periodEnd:     new Date().toISOString(),
        streams: {
          sessionsLogged:  sessionCount,
          messagesLogged:  totalMessages,
          messagesFlagged: totalFlags,
        },
        discord: {
          alertsFired: discordAlerts,
        },
      };

      return json(res, 200, digest);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ── BROADCAST ENDPOINT ───────────────────────────────────────────────────────

  // POST /broadcast — send a message to selected guilds' alert channels
  if (req.method === 'POST' && req.url === '/broadcast' && isAuthenticated(req)) {
    try {
      const { message, guildIds, urgency, retractable } = JSON.parse(_rawBody || '{}');
      if (!message) return json(res, 400, { error: 'Message required' });

      const { EmbedBuilder } = require('discord.js');
      const colors = { info: 0x0d9488, warning: 0xc4962a, critical: 0xc44a2a };
      const color  = colors[urgency] || colors.info;
      const icons  = { info: '⊹', warning: '⚠', critical: '🚨' };
      const icon   = icons[urgency] || icons.info;

      const cfg        = monitor ? monitor.loadConfig() : {};
      const targetIds  = (guildIds && guildIds.length) ? guildIds : Object.keys(cfg);
      const broadcastId = genBizId('BRD');
      const results    = [];

      for (const guildId of targetIds) {
        const gCfg = cfg[guildId];
        if (!gCfg?.alertChannelId) { results.push({ guildId, ok: false, reason: 'No alert channel configured' }); continue; }
        const guild = client.guilds.cache.get(guildId);
        if (!guild) { results.push({ guildId, ok: false, reason: 'Guild not found' }); continue; }
        const channel = guild.channels.cache.get(gCfg.alertChannelId);
        if (!channel) { results.push({ guildId, ok: false, reason: 'Alert channel not found' }); continue; }

        const modMention = monitor ? monitor.getModRoleMention(gCfg) : '';
        const embed = new EmbedBuilder()
          .setColor(color)
          .setAuthor({ name: icon + ' Broadcast from Aether' })
          .setDescription((modMention ? modMention + '\n\n' : '') + message)
          .setFooter({ text: 'AetherTek Broadcast · ' + broadcastId + ' · ' + new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short' }) + ' CST' })
          .setTimestamp();

        try {
          const sent = await channel.send({ embeds: [embed] });
          results.push({ guildId, guildName: guild.name, ok: true, messageId: sent.id, channelId: gCfg.alertChannelId });
        } catch (err) {
          results.push({ guildId, guildName: guild.name, ok: false, reason: err.message });
        }
      }

      // Store broadcast record
      const broadcastsFile = path.join(STORAGE_DIR, 'broadcasts.json');
      const broadcasts = (() => { try { return JSON.parse(fs.readFileSync(broadcastsFile, 'utf8')); } catch { return []; } })();
      const record = { id: broadcastId, message, urgency: urgency || 'info', sentAt: new Date().toISOString(), results };
      broadcasts.unshift(record);
      if (broadcasts.length > 200) broadcasts.splice(200);
      fs.writeFileSync(broadcastsFile, JSON.stringify(broadcasts, null, 2));

      logActivity('broadcast.sent', 'Broadcast ' + broadcastId + ' sent to ' + results.filter(r => r.ok).length + '/' + results.length + ' servers', { id: broadcastId, urgency });
      hauscallLog('info', 'discord', 'Broadcast ' + broadcastId + ' sent to ' + results.filter(r => r.ok).length + '/' + results.length + ' servers');

      return json(res, 200, { ok: true, broadcastId, results });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // GET /broadcasts — recent broadcast history
  if (req.method === 'GET' && req.url === '/broadcasts' && isAuthenticated(req)) {
    const broadcastsFile = path.join(STORAGE_DIR, 'broadcasts.json');
    const broadcasts = (() => { try { return JSON.parse(fs.readFileSync(broadcastsFile, 'utf8')); } catch { return []; } })();
    return json(res, 200, { broadcasts: broadcasts.slice(0, 50) });
  }

  // POST /broadcast/retract — delete a broadcast message from all servers it was sent to
  if (req.method === 'POST' && req.url === '/broadcast/retract' && isAuthenticated(req)) {
    const { broadcastId } = JSON.parse(_rawBody || '{}');
    const broadcastsFile  = path.join(STORAGE_DIR, 'broadcasts.json');
    const broadcasts = (() => { try { return JSON.parse(fs.readFileSync(broadcastsFile, 'utf8')); } catch { return []; } })();
    const record = broadcasts.find(b => b.id === broadcastId);
    if (!record) return json(res, 404, { error: 'Broadcast not found' });

    const retracted = [];
    for (const result of (record.results || [])) {
      if (!result.ok || !result.messageId) continue;
      try {
        const guild   = client.guilds.cache.get(result.guildId);
        const channel = guild?.channels.cache.get(result.channelId);
        const msg     = await channel?.messages.fetch(result.messageId).catch(() => null);
        if (msg) { await msg.delete(); retracted.push(result.guildId); }
      } catch { /* ignore */ }
    }

    logActivity('broadcast.retracted', 'Broadcast ' + broadcastId + ' retracted from ' + retracted.length + ' server(s)', { id: broadcastId });
    return json(res, 200, { ok: true, retracted: retracted.length });
  }

  // ── ONBOARDING CHECKLIST ─────────────────────────────────────────────────────

  // GET /onboarding/:username — returns checklist state for a streamer
  if (req.method === 'GET' && req.url.startsWith('/onboarding/') && !req.url.includes('/status') && isAuthenticated(req)) {
    const username = decodeURIComponent(req.url.split('/onboarding/')[1]).toLowerCase();

    // Load all the data needed to auto-check items
    const streamers    = JSON.parse(fs.existsSync(path.join(STORAGE_DIR, 'streamers.json'))
      ? fs.readFileSync(path.join(STORAGE_DIR, 'streamers.json'), 'utf8') : '[]');
    const streamer     = streamers.find(s => s.username.toLowerCase() === username);
    const monitorCfg   = monitor ? monitor.loadConfig() : {};
    const partnerships = loadBusiness(PARTNERSHIP_FILE);
    const notes        = loadNotes();
    const transcripts  = (() => {
      try {
        const tDir = path.join(STORAGE_DIR, 'transcripts');
        if (!fs.existsSync(tDir)) return [];
        return fs.readdirSync(tDir).filter(f => f.startsWith(username + '-'));
      } catch { return []; }
    })();

    // Load manual overrides (persisted per-streamer)
    const overridesFile = path.join(STORAGE_DIR, 'onboarding-overrides.json');
    const overrides = (() => {
      try { return JSON.parse(fs.readFileSync(overridesFile, 'utf8')); } catch { return {}; }
    })();
    const ov = overrides[username] || {};

    // Find guild config for this streamer
    const guildEntry = Object.entries(monitorCfg).find(([, cfg]) =>
      cfg.watchedChannels?.length || cfg.alertChannelId
    );

    // Build moderation ruleset check
    const { DEFAULT_RULESETS } = require('./moderation');
    const hasRuleset = !!(DEFAULT_RULESETS[username]);

    const checklist = [
      // Twitch
      { id: 'twitch.added',    category: 'twitch',  label: 'Streamer added to Hauscall monitoring',  auto: true,  checked: !!streamer },
      { id: 'twitch.ruleset',  category: 'twitch',  label: 'Moderation ruleset defined',             auto: true,  checked: hasRuleset },
      { id: 'twitch.watched',  category: 'twitch',  label: 'Watched users list reviewed',            auto: false, checked: ov['twitch.watched'] || false },
      // Discord
      { id: 'discord.hauscall',  category: 'discord', label: 'Hauscall added to server',            auto: false, checked: ov['discord.hauscall'] || false },
      { id: 'discord.alert',     category: 'discord', label: 'Alert channel configured',            auto: true,  checked: Object.values(monitorCfg).some(cfg => cfg.alertChannelId) && (ov['discord.alert'] !== false) },
      { id: 'discord.watched',   category: 'discord', label: 'Watched channels configured',         auto: true,  checked: Object.values(monitorCfg).some(cfg => cfg.watchedChannels?.length > 0) },
      { id: 'discord.modrole',   category: 'discord', label: 'Mod role ID set',                     auto: true,  checked: Object.values(monitorCfg).some(cfg => cfg.modRoleId) },
      { id: 'discord.perms',     category: 'discord', label: 'Permissions verified',                auto: false, checked: ov['discord.perms'] || false },
      // General
      { id: 'general.partnership', category: 'general', label: 'Partnership application accepted',  auto: true,  checked: partnerships.some(p => p.status === 'accepted' && (p.discord || '').toLowerCase().includes(username.slice(0,4))) || ov['general.partnership'] || false },
      { id: 'general.session',     category: 'general', label: 'First transcript session completed', auto: true, checked: transcripts.length > 0 },
      { id: 'general.briefed',     category: 'general', label: 'Streamer briefed on Hauscall',      auto: false, checked: ov['general.briefed'] || false },
    ];

    const total    = checklist.length;
    const complete = checklist.filter(c => c.checked).length;

    return json(res, 200, { username, checklist, complete, total, percent: Math.round((complete/total)*100) });
  }

  // PATCH /onboarding/:username/status — save manual override for a checklist item
  if (req.method === 'PATCH' && req.url.startsWith('/onboarding/') && req.url.includes('/status') && isAuthenticated(req)) {
    const username = decodeURIComponent(req.url.split('/onboarding/')[1].split('/status')[0]).toLowerCase();
    const { itemId, checked } = JSON.parse(_rawBody || '{}');
    const overridesFile = path.join(STORAGE_DIR, 'onboarding-overrides.json');
    const overrides = (() => {
      try { return JSON.parse(fs.readFileSync(overridesFile, 'utf8')); } catch { return {}; }
    })();
    if (!overrides[username]) overrides[username] = {};
    overrides[username][itemId] = checked;
    fs.writeFileSync(overridesFile, JSON.stringify(overrides, null, 2));
    logActivity('onboarding.update', username + ': ' + itemId + ' marked ' + (checked ? 'complete' : 'incomplete'), { username, itemId, checked });
    return json(res, 200, { ok: true });
  }

  // ── ACTIVITY LOG ENDPOINTS ───────────────────────────────────────────────────

  // GET /activity?limit=100 — recent activity log
  if (req.method === 'GET' && req.url.startsWith('/activity') && isAuthenticated(req)) {
    const qp    = new URL('http://x' + req.url).searchParams;
    const limit = Math.min(parseInt(qp.get('limit') || '200'), 1000);
    const since = qp.get('since') || null; // ISO timestamp
    let entries = loadActivity();
    if (since) entries = entries.filter(e => e.timestamp > since);
    return json(res, 200, { activity: entries.slice(0, limit), total: entries.length });
  }

  // POST /activity — log an action from the Desk
  if (req.method === 'POST' && req.url === '/activity' && isAuthenticated(req)) {
    const { action, detail, meta } = JSON.parse(_rawBody || '{}');
    if (!action || !detail) return json(res, 400, { error: 'action and detail required' });
    logActivity(action, detail, meta || {});
    return json(res, 200, { ok: true });
  }

  // ── STREAMER NOTES ENDPOINTS ──────────────────────────────────────────────────

  // GET /notes/:streamer — get notes for a streamer
  if (req.method === 'GET' && req.url.startsWith('/notes/') && isAuthenticated(req)) {
    const streamer = decodeURIComponent(req.url.split('/notes/')[1]).toLowerCase();
    const notes    = loadNotes();
    return json(res, 200, { streamer, notes: notes[streamer] || '' });
  }

  // PATCH /notes/:streamer — save notes for a streamer
  if (req.method === 'PATCH' && req.url.startsWith('/notes/') && isAuthenticated(req)) {
    const streamer = decodeURIComponent(req.url.split('/notes/')[1]).toLowerCase();
    const { notes } = JSON.parse(_rawBody || '{}');
    const all = loadNotes();
    all[streamer] = notes || '';
    saveNotes(all);
    logActivity('notes.save', 'Streamer notes updated: ' + streamer, { streamer });
    return json(res, 200, { ok: true, streamer, notes: all[streamer] });
  }

  // GET /notes — get all streamer notes
  if (req.method === 'GET' && req.url === '/notes' && isAuthenticated(req)) {
    return json(res, 200, { notes: loadNotes() });
  }

  // ── EVENTSUB WEBHOOK ─────────────────────────────────────────────────────────

  if (req.url === '/eventsub') {
    // Twitch EventSub challenge/verification
    if (req.method === 'POST') {
      const msgId    = req.headers['twitch-eventsub-message-id']        || '';
      const ts       = req.headers['twitch-eventsub-message-timestamp'] || '';
      const sig      = req.headers['twitch-eventsub-message-signature'] || '';
      const msgType  = req.headers['twitch-eventsub-message-type']      || '';

      // Verify signature
      if (!twitch.verifyEventSubSignature(msgId, ts, _rawBody, sig)) {
        hauscallLog('warn', 'twitch', 'EventSub signature verification failed');
        res.writeHead(403); res.end(); return;
      }

      const payload = JSON.parse(_rawBody || '{}');

      // Respond to challenge (initial subscription verification)
      if (msgType === 'webhook_callback_verification') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(payload.challenge || '');
        hauscallLog('info', 'twitch', 'EventSub subscription verified: ' + payload.subscription?.type);
        return;
      }

      // Handle notification
      if (msgType === 'notification') {
        const subType = payload.subscription?.type || '';
        const event   = payload.event || {};

        if (subType === 'channel.hype_train.end') {
          const channel      = (event.broadcaster_user_login || '').toLowerCase();
          const level        = event.level || 1;
          const contributions = (event.top_contributions || []).length + (event.last_contribution ? 1 : 0);
          const totalContrib  = event.total || contributions;

          // Record to storage
          recordHypeTrain(channel, level, totalContrib);

          // Log to active session if one is running
          twitch.logHypeTrain(channel, level, totalContrib);

          // Post to alert channel if configured
          const monCfg = monitor ? monitor.loadConfig() : {};
          for (const [guildId, cfg] of Object.entries(monCfg)) {
            if (!cfg.alertChannelId) continue;
            const guild = client.guilds.cache.get(guildId);
            const ch    = guild?.channels.cache.get(cfg.alertChannelId);
            if (!ch) continue;
            const { EmbedBuilder } = require('discord.js');
            await ch.send({ embeds: [
              new EmbedBuilder()
                .setColor(0x9146ff)
                .setTitle('🚂 Hype Train Ended — Level ' + level)
                .setDescription(
                  '**Channel:** ' + channel + '\n' +
                  '**Level Reached:** ' + level + '\n' +
                  '**Total Contributions:** ' + totalContrib.toLocaleString()
                )
                .setFooter({ text: 'AetherTek · Hype Train Tracker' })
                .setTimestamp()
            ]}).catch(() => {});
          }
        }

        if (subType === 'channel.hype_train.begin') {
          const channel = (event.broadcaster_user_login || '').toLowerCase();
          hauscallLog('info', 'twitch', 'Hype Train started in #' + channel);
        }
      }

      res.writeHead(200); res.end(); return;
    }
  }

  // GET /hype-trains/:channel — leaderboard for a streamer
  if (req.method === 'GET' && req.url.startsWith('/hype-trains/') && isAuthenticated(req)) {
    const channel = req.url.split('/hype-trains/')[1].toLowerCase();
    const all     = loadHypeTrains();
    return json(res, 200, { channel, trains: all[channel] || [] });
  }

  // GET /hype-trains — all channels
  if (req.method === 'GET' && req.url === '/hype-trains' && isAuthenticated(req)) {
    return json(res, 200, { trains: loadHypeTrains() });
  }

  // ── HEALTH & LOG ENDPOINTS ───────────────────────────────────────────────────

  // GET /digest — public weekly metrics (no auth required)
  if (req.method === 'GET' && req.url === '/digest') {
    try {
      const digest = fs.existsSync(DIGEST_FILE)
        ? JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8'))
        : null;
      return json(res, 200, { digest });
    } catch { return json(res, 200, { digest: null }); }
  }

  // GET /health — subsystem status + recent errors
  if (req.method === 'GET' && req.url === '/health' && isAuthenticated(req)) {
    const logs    = loadLogs();
    const recent  = logs.slice(0, 50);
    const errors  = logs.filter(l => l.level === 'error').slice(0, 20);
    const warns   = logs.filter(l => l.level === 'warn').slice(0, 20);
    const uptime  = process.uptime();
    return json(res, 200, {
      uptime,
      uptimeFormatted: (() => {
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);
        return `${h}h ${m}m ${s}s`;
      })(),
      subsystems: healthState,
      recentErrors: errors,
      recentWarns:  warns,
      recentLogs:   recent,
      totalLogged:  logs.length,
    });
  }

  // GET /logs?level=error&subsystem=twitch&limit=100 — filtered log query
  if (req.method === 'GET' && req.url.startsWith('/logs') && isAuthenticated(req)) {
    const qp        = new URL('http://x' + req.url).searchParams;
    const level     = qp.get('level')     || null;
    const subsystem = qp.get('subsystem') || null;
    const limit     = Math.min(parseInt(qp.get('limit') || '100'), 500);
    let   logs      = loadLogs();
    if (level)     logs = logs.filter(l => l.level     === level);
    if (subsystem) logs = logs.filter(l => l.subsystem === subsystem);
    return json(res, 200, { logs: logs.slice(0, limit), total: logs.length });
  }

  // DELETE /logs — clear log store
  if (req.method === 'DELETE' && req.url === '/logs' && isAuthenticated(req)) {
    saveLogs([]);
    // Reset health state
    Object.keys(healthState).forEach(k => {
      healthState[k].status  = 'ok';
      healthState[k].detail  = 'Log cleared';
    });
    hauscallLog('info', 'server', 'Log store cleared by operator');
    return json(res, 200, { ok: true });
  }

  // ── BUSINESS TICKET ENDPOINTS (authenticated) ───────────────────────────────

  // GET /partnerships — list all partnership applications
  if (req.method === 'GET' && req.url === '/partnerships' && isAuthenticated(req)) {
    return json(res, 200, { partnerships: loadBusiness(PARTNERSHIP_FILE) });
  }

  // GET /commissions — list all commission briefs
  if (req.method === 'GET' && req.url === '/commissions' && isAuthenticated(req)) {
    return json(res, 200, { commissions: loadBusiness(COMMISSION_FILE) });
  }

  // PATCH /partnership/:id/status — update status and optionally DM applicant
  if (req.method === 'PATCH' && req.url.startsWith('/partnership/') && req.url.includes('/status') && isAuthenticated(req)) {
    const id      = req.url.split('/')[2];
    const parsed  = JSON.parse(_rawBody || '{}');
    const { status, notes } = parsed;
    const all     = loadBusiness(PARTNERSHIP_FILE);
    const idx     = all.findIndex(p => p.id === id);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    all[idx].status    = status || all[idx].status;
    all[idx].notes     = notes  !== undefined ? notes : all[idx].notes;
    all[idx].updatedAt = new Date().toISOString();
    saveBusiness(PARTNERSHIP_FILE, all);

    // DM applicant on accept or decline
    const record = all[idx];
    if ((status === 'accepted' || status === 'declined') && record.discord) {
      try {
        const guild = client.guilds.cache.first();
        if (guild) {
          const members = await guild.members.fetch({ query: record.discord.replace(/#\d{4}$/, ''), limit: 5 }).catch(() => null);
          const member  = members?.find(m =>
            m.user.tag === record.discord ||
            m.user.username === record.discord.replace(/#\d{4}$/, '')
          );
          if (member) {
            const dmMsg = status === 'accepted'
              ? `Greetings, ${member.displayName}. Hauscall here, on behalf of Aether.

Your AetherTek Partnership application for **${record.server}** has been **accepted**.

Aether will reach out shortly to start working with you on your project. Welcome aboard.

— Hauscall, Familiar of Aetherhaus`
              : `Greetings, ${member.displayName}. Hauscall here, on behalf of Aether.

Your AetherTek Partnership application for **${record.server}** has been reviewed. Unfortunately, on this occasion the answer is no.

Aether will reach out to explain why shortly.

— Hauscall, Familiar of Aetherhaus`;
            await member.send(dmMsg).catch(err => hauscallLog('error','discord','Partnership DM failed: ' + err.message));
          }
        }
      } catch (err) { hauscallLog('error','discord','Partnership DM error: ' + err.message); }
    }

    return json(res, 200, { ok: true, record: all[idx] });
  }

  // PATCH /commission/:id/status — update status and optionally DM applicant
  if (req.method === 'PATCH' && req.url.startsWith('/commission/') && req.url.includes('/status') && isAuthenticated(req)) {
    const id      = req.url.split('/')[2];
    const parsed  = JSON.parse(_rawBody || '{}');
    const { status, notes } = parsed;
    const all     = loadBusiness(COMMISSION_FILE);
    const idx     = all.findIndex(c => c.id === id);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    all[idx].status    = status || all[idx].status;
    all[idx].notes     = notes  !== undefined ? notes : all[idx].notes;
    all[idx].updatedAt = new Date().toISOString();
    saveBusiness(COMMISSION_FILE, all);

    // DM applicant on accept or decline
    const record = all[idx];
    if ((status === 'accepted' || status === 'declined') && record.discord) {
      try {
        const guild = client.guilds.cache.first();
        if (guild) {
          const members = await guild.members.fetch({ query: record.discord.replace(/#\d{4}$/, ''), limit: 5 }).catch(() => null);
          const member  = members?.find(m =>
            m.user.tag === record.discord ||
            m.user.username === record.discord.replace(/#\d{4}$/, '')
          );
          if (member) {
            const dmMsg = status === 'accepted'
              ? `Greetings, ${member.displayName}. Hauscall here, on behalf of Aether.

Your project commission brief **${record.id}** has been reviewed and accepted.

Aether will reach out shortly to start working with you on your project — scope, timeline, and cost will all be discussed openly.

— Hauscall, Familiar of Aetherhaus`
              : `Greetings, ${member.displayName}. Hauscall here, on behalf of Aether.

Your project commission brief **${record.id}** has been reviewed. On this occasion, Aether is unable to take it on.

Aether will reach out to explain why shortly. This is never a permanent answer — circumstances change.

— Hauscall, Familiar of Aetherhaus`;
            await member.send(dmMsg).catch(err => hauscallLog('error','discord','Commission DM failed: ' + err.message));
          }
        }
      } catch (err) { hauscallLog('error','discord','Commission DM error: ' + err.message); }
    }

    return json(res, 200, { ok: true, record: all[idx] });
  }

  // POST /monitor/scan/:guildId — trigger manual retrospective scan for one guild
  if (req.method === 'POST' && req.url.startsWith('/monitor/scan/') && isAuthenticated(req)) {
    const guildId = req.url.split('/monitor/scan/')[1];
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    // Run async — respond immediately so Desk doesn't time out
    json(res, 202, { ok: true, message: 'Retro scan started' });
    monitor.retroScan(client, guildId).then(result => {
      console.log(`⊹ Manual retro scan complete for ${guildId}: ${result.scanned} scanned, ${result.flagged} flagged`);
    }).catch(err => console.error('⊹ Manual retro scan error:', err.message));
    return;
  }

  // GET /monitor/alerts/:guildId — alert log for one guild (last 100, 7-day window)
  if (req.method === 'GET' && req.url.startsWith('/monitor/alerts/') && isAuthenticated(req)) {
    const guildId = req.url.split('/monitor/alerts/')[1];
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    const alerts  = monitor.getAlerts(guildId, 100);
    if (!monitor) return json(res, 503, { error: 'Monitor not available' });
    const cfg     = monitor.getGuildConfig(guildId);
    return json(res, 200, {
      alerts,
      lifetimeCount: cfg?.lifetimeCount || 0,
      guildId,
    });
  }

  // GET /moderation/rules/:channel — get rules for a specific streamer
  if (req.method === 'GET' && req.url.startsWith('/moderation/rules/') && isAuthenticated(req)) {
    const channel = req.url.split('/moderation/rules/')[1];
    const streamer = twitch.getStreamers().find(s => s.username === channel);
    if (!streamer) return json(res, 404, { error: 'Streamer not found' });
    const { DEFAULT_RULESETS } = require('./moderation');
    const rules = streamer.rules || DEFAULT_RULESETS[channel] || { rules: [] };
    return json(res, 200, { channel, rules });
  }

  // ── WATCHED USERS API ─────────────────────────────────────────────────────

  // GET /watched/:channel — get watch list for a streamer
  if (req.method === 'GET' && req.url.startsWith('/watched/') && !req.url.includes('/add') && !req.url.includes('/remove') && isAuthenticated(req)) {
    const channel = decodeURIComponent(req.url.split('/watched/')[1]);
    return json(res, 200, { channel, watchedUsers: twitch.getWatchedUsers(channel) });
  }

  // POST /watched/:channel/add — { username }
  if (req.method === 'POST' && req.url.endsWith('/add') && req.url.includes('/watched/') && isAuthenticated(req)) {
    const channel = decodeURIComponent(req.url.split('/watched/')[1].replace('/add', ''));
    const parsed  = getBody(_rawBody);
    if (!parsed?.username) return json(res, 400, { error: 'username required' });
    return json(res, 200, twitch.addWatchedUser(channel, parsed.username));
  }

  // POST /watched/:channel/remove — { username }
  if (req.method === 'POST' && req.url.endsWith('/remove') && req.url.includes('/watched/') && isAuthenticated(req)) {
    const channel = decodeURIComponent(req.url.split('/watched/')[1].replace('/remove', ''));
    const parsed  = getBody(_rawBody);
    if (!parsed?.username) return json(res, 400, { error: 'username required' });
    return json(res, 200, twitch.removeWatchedUser(channel, parsed.username));
  }

  // GET /discord/transcript-settings — fetch persisted post settings for all channels
  if (req.method === 'GET' && req.url === '/discord/transcript-settings' && isAuthenticated(req)) {
    return json(res, 200, { settings: db.getTranscriptPostSettings() });
  }

  // POST /discord/transcript-settings — save post settings from Desk
  if (req.method === 'POST' && req.url === '/discord/transcript-settings' && isAuthenticated(req)) {
    const parsed = getBody(_rawBody);
    if (!parsed?.settings) return json(res, 400, { error: 'settings object required' });
    db.saveTranscriptPostSettings(parsed.settings);
    return json(res, 200, { ok: true });
  }

  // POST /transcript/post — post a transcript to a Discord channel
  // Body: { guildId, channelId, channel (twitch), sessionId, dateLabel, messages[], autoPost }
  if (req.method === 'POST' && req.url === '/transcript/post' && isAuthenticated(req)) {
    const body = getBody(_rawBody);
    if (!body) return json(res, 400, { error: 'Invalid body' });

    const { guildId, channelId, channel, sessionId, dateLabel, messages, autoPost } = body;
    if (!guildId || !channelId || !channel || !messages) {
      return json(res, 400, { error: 'guildId, channelId, channel, and messages are required' });
    }

    const guild   = client.guilds.cache.get(guildId);
    if (!guild)   return json(res, 404, { error: 'Guild not found — Hauscall may not be in that server' });

    const discordChannel = guild.channels.cache.get(channelId);
    if (!discordChannel) return json(res, 404, { error: 'Channel not found' });
    if (discordChannel.type !== 0) return json(res, 400, { error: 'Channel is not a text channel' });

    // Check Hauscall has permission to send messages in this channel
    const perms = discordChannel.permissionsFor(guild.members.me);
    if (!perms?.has('SendMessages')) {
      return json(res, 403, { error: 'Hauscall does not have Send Messages permission in that channel' });
    }
    if (!perms?.has('AttachFiles')) {
      return json(res, 403, { error: 'Hauscall does not have Attach Files permission in that channel' });
    }

    try {
      // Build the transcript text content (same format as .txt download)
      const lines = messages.map(m => {
        const ts = new Date(m.timestamp).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false, timeZone: 'America/Chicago'
        });
        return `[${ts}] ${m.username}: ${m.message}`;
      });

      const header = [
        'AetherTek Chat Transcript',
        `Channel: ${channel}`,
        `Date: ${dateLabel || new Date().toLocaleDateString()}`,
        `Messages: ${messages.length}`,
        `Session ID: ${sessionId || 'unknown'}`,
        `Posted: ${new Date().toLocaleString('en-US', { timeZone:'America/Chicago', dateStyle:'medium', timeStyle:'short' })} CST`,
        `Auto-posted: ${autoPost ? 'Yes' : 'No — manual post'}`,
        '─────────────────────────────────────',
        '',
      ].join('\n');

      const fullText = header + lines.join('\n');

      // Post as a file attachment so long transcripts aren't truncated
      const { AttachmentBuilder, EmbedBuilder: EB } = require('discord.js');
      // Append violations and watched reports if available
      let manualViolations = '';
      let manualWatched    = '';
      let manualConfirmed  = 0;
      let manualReview     = 0;
      let manualWatchCount = 0;
      try {
        if (sessionId) {
          const tDir  = path.join(STORAGE_DIR, 'transcripts');
          const files = fs.readdirSync(tDir).filter(f => f.includes(sessionId) && f.endsWith('.json'));
          if (files.length) {
            const fresh = JSON.parse(fs.readFileSync(path.join(tDir, files[0]), 'utf8'));
            manualViolations = fresh.violationsReport || '';
            manualWatched    = fresh.watchedReport    || '';
            manualWatchCount = fresh.watchedMessages?.length || 0;
            manualConfirmed  = fresh.claudeFlags?.confirmed?.length || 0;
            manualReview     = fresh.claudeFlags?.review?.length    || 0;
            const rtC = (fresh.realTimeFlags || []).filter(f => f.flags.some(fl => fl.severity === 'confirmed')).length;
            manualConfirmed += rtC;
          }
        }
      } catch {}

      const fullTextWithReport = fullText +
        (manualViolations ? '\n' + manualViolations : '') +
        (manualWatched    ? '\n' + manualWatched    : '');
      const buf        = Buffer.from(fullTextWithReport, 'utf8');
      const attachment = new AttachmentBuilder(buf, {
        name: `transcript_${channel}_${sessionId || Date.now()}.txt`,
      });

      const manualFlagSummary  = manualConfirmed || manualReview
        ? `\n**Flags:** ${manualConfirmed} confirmed · ${manualReview} for review`
        : '\n**Flags:** None raised';
      const manualWatchSummary = manualWatchCount
        ? `\n**Watched:** ${manualWatchCount} message${manualWatchCount !== 1 ? 's' : ''} logged`
        : '';

      const embed = new EmbedBuilder()
        .setColor(manualConfirmed > 0 ? 0xc44a2a : manualReview > 0 ? 0xc4962a : 0x7c4daa)
        .setTitle(`📜 Chat Transcript — ${channel}`)
        .setDescription(
          `**Date:** ${dateLabel || 'Unknown'}\n` +
          `**Messages:** ${messages.length.toLocaleString()}\n` +
          `**Session:** \`${sessionId || 'unknown'}\`` +
          manualFlagSummary + manualWatchSummary + `\n` +
          `**Posted by:** ${autoPost ? 'Hauscall (auto)' : 'Aether (manual)'}`
        )
        .setFooter({ text: 'AetherhausStudios · AetherTek Transcript Archive' })
        .setTimestamp();

      await discordChannel.send({ embeds: [embed], files: [attachment] });

      console.log(`⊹ Transcript posted: ${channel} → #${discordChannel.name} in ${guild.name}`);
      return json(res, 200, { ok: true, postedTo: discordChannel.name, guild: guild.name });

    } catch (err) {
      console.error('Transcript post error:', err.message);
      return json(res, 500, { error: 'Failed to post transcript: ' + err.message });
    }
  }

  res.writeHead(404); res.end();
});


// ── TICKET HANDLER ────────────────────────────────────────────────────────────

async function getSharedServers(discordId) {
  if (!discordId) return 'No User ID provided';
  const shared = [];
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch(discordId);
      shared.push(guild.name);
    } catch { /* not in this guild */ }
  }
  return shared.length ? shared.join(', ') : '⚠️ None — not found in any connected server';
}

async function handleTicket(data, res) {
  const { name, discord, discordId, notify, category, urgency, description, tried } = data;

  // Hauscall generates the ID
  const id       = genTicketId('TKT');
  const open     = db.getOpenTickets();
  const position = open.length + 1;

  // Check which connected servers the submitter is in
  const sharedServers = await getSharedServers(discordId);

  db.addTicket({
    id, name, discord, discordId, notify,
    category, urgency, description, tried,
    sharedServers,
    status: 'open',
    createdAt: new Date().toISOString(),
  });

  // Post embed to workspace ticket channel
  const channel = await getTicketChannel();
  if (channel) {
    const urgencyLabels = { low: '🌿 Chill', med: '🕯 Burning', high: '🔥 ON FIRE' };
    const urgencyColors = { low: 0x3d5c3a, med: 0xc4962a, high: 0xc44a2a };
    const embed = new EmbedBuilder()
      .setTitle(`${id} — New Support Ticket`)
      .setColor(urgencyColors[urgency] || 0x7c4daa)
      .addFields(
        { name: 'Petitioner',     value: name || 'Anonymous',             inline: true },
        { name: 'Discord',        value: discord,                         inline: true },
        { name: 'Notify via DM',  value: notify ? 'Yes' : 'No',          inline: true },
        { name: 'Category',       value: category || 'unspecified',       inline: true },
        { name: 'Urgency',        value: urgencyLabels[urgency] || '—',   inline: true },
        { name: 'Queue Position', value: `#${position}`,                  inline: true },
        { name: 'Affliction',     value: description || '—' },
        { name: 'Already Tried',  value: tried || 'nothing, apparently' },
        { name: 'Shared Servers', value: sharedServers },
      )
      .setFooter({ text: 'AetherhausStudios Support · ' + new Date().toLocaleString() });
    await channel.send({ embeds: [embed] });
  }

  // DM submitter if opted in
  if (notify && discordId) {
    try {
      const user = await client.users.fetch(discordId);
      await user.send(messages.dmTicketReceived(id, position));
    } catch {
      console.warn(`Could not DM ${discord} — DMs may be closed.`);
    }
  }

  // Return the generated ID to the form
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id, position }));
}

// ── HARDWARE INQUIRY HANDLER ──────────────────────────────────────────────────

async function handleHardware(data, res) {
  const { name, discord, discordId, notify, hardware, budget, usecase, prefs, looked, timeSensitive } = data;

  const id = genTicketId('HW');
  const sharedServers = await getSharedServers(discordId);

  db.addTicket({
    id, name, discord, discordId, notify,
    category: 'Hardware Inquiry',
    hardware, budget, usecase, prefs, looked, timeSensitive,
    sharedServers,
    urgency: timeSensitive ? 'med' : 'low',
    status: 'open',
    createdAt: new Date().toISOString(),
  });

  const channel = await getTicketChannel();
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle(`${id} — Hardware Inquiry`)
      .setColor(0xc4962a)
      .addFields(
        { name: 'Petitioner',    value: name || 'Anonymous',           inline: true },
        { name: 'Discord',       value: discord,                       inline: true },
        { name: 'Notify via DM', value: notify ? 'Yes' : 'No',        inline: true },
        { name: 'Hardware Sought', value: (hardware || []).join(', ') || '—' },
        { name: 'Budget',        value: budget || '—',                 inline: true },
        { name: 'Use Case',      value: usecase || '—',                inline: true },
        { name: 'Time Sensitive', value: timeSensitive ? 'Yes ⚡' : 'No', inline: true },
        { name: 'Preferences',   value: prefs || 'none specified' },
        { name: 'Already Looked At', value: looked || 'nothing yet' },
        { name: 'Shared Servers', value: sharedServers },
      )
      .setFooter({ text: 'AetherhausStudios Hardware Inquiry · ' + new Date().toLocaleString() });
    await channel.send({ embeds: [embed] });
  }

  if (notify && discordId) {
    try {
      const user = await client.users.fetch(discordId);
      await user.send(messages.dmTicketReceived(id, db.getOpenTickets().length));
    } catch {
      console.warn(`Could not DM ${discord}`);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id }));
}

// ── REPORT HANDLER ────────────────────────────────────────────────────────────

async function handleReport(data, res) {
  const { handle, nature, server, context, reporter, notify, discordId } = data;
  const id = genTicketId('RPT');

  // Store as a ticket in the database with critical urgency for queue tracking
  db.addTicket({
    id,
    discord:     reporter || 'Anonymous',
    discordId:   discordId || null,
    notify:      notify || false,
    category:    'Compromised Account Report',
    urgency:     'critical',
    description: `${nature} — Reported account: ${handle}${server ? ` in ${server}` : ''}`,
    tried:       context || 'none provided',
    reportedHandle: handle,
    nature,
    server:      server || 'not specified',
    status:      'open',
    createdAt:   new Date().toISOString(),
  });

  db.addHistoryEntry(handle, { type: 'report', detail: `${nature} — reported by ${reporter || 'Anonymous'}` });

  const channel = await getTicketChannel();
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle(`${id} — 🚨 COMPROMISED ACCOUNT REPORT`)
      .setColor(0xff0000)
      .addFields(
        { name: '🎯 Reported Account',   value: `**${handle}**`,                 inline: true },
        { name: '⚠️ Nature of Incident', value: nature,                          inline: true },
        { name: '📍 Server',             value: server || 'not specified',        inline: true },
        { name: '👤 Reported By',        value: reporter || 'Anonymous',          inline: true },
        { name: '🔔 Notify Reporter',    value: notify ? 'Yes' : 'No / Anonymous', inline: true },
        { name: '📋 Additional Context', value: context || 'none provided' },
      )
      .setFooter({ text: 'AetherhausStudios Security Report · ' + new Date().toLocaleString() });

    // @here ping so it never gets missed
    await channel.send({ content: `@here 🚨 **Security Report Incoming** — ${id}`, embeds: [embed] });
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id }));
}

// ── REVIEW HANDLER ────────────────────────────────────────────────────────────

async function handleReview(data, res) {
  const { ticketId, name, stars, service, review, quote } = data;

  db.addReview({
    ticketId, name, stars, service, review, quote,
    createdAt: new Date().toISOString()
  });

  const channel = await getTicketChannel();
  if (channel) {
    await channel.send(messages.workspaceReviewReceived(ticketId, stars, quote));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function getTicketChannel() {
  try {
    const guild   = await client.guilds.fetch(CONFIG.guildId);
    const channel = await guild.channels.fetch(CONFIG.ticketChannelId);
    return channel;
  } catch {
    console.warn('Could not fetch ticket channel.');
    return null;
  }
}

// ── START ─────────────────────────────────────────────────────────────────────

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`⊹ Hauscall receiver listening on port ${CONFIG.port}.`);
});

client.login(CONFIG.token);
