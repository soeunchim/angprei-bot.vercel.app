// HunSenAngPrei_Timetable_Bot Cloud Serverless Function
// Compatible with Vercel 100% Free Tier

const BOT_TOKEN = process.env.BOT_TOKEN || "8642985348:AAFl7lTrZxdkn5kA2Gb9lGTibUMGBCJx0Bo";
const BOT_NAME = process.env.BOT_NAME || "HunSenAngPrei_Timetable_bot";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const DAY_NAMES = {
  1: "ចន្ទ", 2: "អង្គារ", 3: "ពុធ", 4: "ព្រហស្បតិ៍", 5: "សុក្រ", 6: "សៅរ៍", 7: "អាទិត្យ"
};

const DEFAULT_KEYBOARD = {
  keyboard: [
    [{ text: "📅 ថ្ងៃនេះ" }, { text: "📆 ថ្ងៃស្អែក" }],
    [{ text: "🗓️ ទាំងសប្ដាហ៍" }]
  ],
  resize_keyboard: true,
};

// In-memory cache across serverless warm invocations
let cloudData = {
  registered: true,
  snapshot: null,
  snapshotAt: null,
  settings: { enabled: true, morning: "06:30", changes: true },
  teachers: {}, // id -> { id, token, chat_id, tgName, linked }
  notices: []
};

async function sendTelegram(chatId, text, replyMarkup = null) {
  try {
    const body = { chat_id: chatId, text, parse_mode: "HTML" };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function formatDaySchedule(snapshot, teacherId, dayNum) {
  if (!snapshot) return "មិនទាន់មានទិន្នន័យកាលវិភាគនៅឡើយទេ។";
  const teacher = (snapshot.teachers || []).find(t => t.id === teacherId);
  const teacherName = teacher ? teacher.name : teacherId;
  const dayName = DAY_NAMES[dayNum] || `ថ្ងៃទី ${dayNum}`;
  const daySlots = (snapshot.slots || []).filter(s => s.t === teacherId && s.d === dayNum);

  let msg = `📅 <b>កាលវិភាគបង្រៀន: ថ្ងៃ${dayName}</b>\n`;
  msg += `🏫 សាលា: <b>${snapshot.school || "វិទ្យាល័យ ហ៊ុន សែន អង្គប្រីយ៍"}</b>\n`;
  msg += `👨‍🏫 គ្រូ: <b>${teacherName}</b>\n`;
  msg += `────────────────────\n`;

  if (daySlots.length === 0) {
    msg += `🎉 <i>ថ្ងៃនេះលោកគ្រូ/អ្នកគ្រូគ្មានម៉ោងបង្រៀនទេ (សម្រាក)!</i>\n`;
  } else {
    daySlots.sort((a, b) => a.p - b.p);
    for (const slot of daySlots) {
      const pInfo = (snapshot.periods || []).find(p => p.p === slot.p);
      const label = pInfo ? pInfo.label : `ម៉ោងទី ${slot.p + 1}`;
      const time = pInfo?.time ? ` (${pInfo.time})` : "";
      msg += `⏰ <b>${label}</b>${time}\n`;
      msg += `   📚 មុខវិជ្ជា: <b>${slot.s}</b> | ថ្នាក់: <b>${slot.c}</b>\n\n`;
    }
  }
  return msg;
}

function formatWeekSchedule(snapshot, teacherId) {
  if (!snapshot) return "មិនទាន់មានទិន្នន័យកាលវិភាគនៅឡើយទេ។";
  const teacher = (snapshot.teachers || []).find(t => t.id === teacherId);
  const teacherName = teacher ? teacher.name : teacherId;

  let msg = `🗓️ <b>កាលវិភាគពេញមួយសប្ដាហ៍</b>\n`;
  msg += `🏫 សាលា: <b>${snapshot.school || "វិទ្យាល័យ ហ៊ុន សែន អង្គប្រីយ៍"}</b>\n`;
  msg += `👨‍🏫 គ្រូ: <b>${teacherName}</b>\n`;
  msg += `════════════════════\n`;

  const days = snapshot.days || [1, 2, 3, 4, 5, 6];
  let hasAny = false;
  for (const d of days) {
    const dayName = DAY_NAMES[d] || `ថ្ងៃ ${d}`;
    const slots = (snapshot.slots || []).filter(s => s.t === teacherId && s.d === d);
    if (slots.length > 0) {
      hasAny = true;
      msg += `\n📌 <b>ថ្ងៃ${dayName}:</b>\n`;
      slots.sort((a, b) => a.p - b.p);
      for (const slot of slots) {
        const pInfo = (snapshot.periods || []).find(p => p.p === slot.p);
        const label = pInfo ? pInfo.label : `ម៉ោង ${slot.p + 1}`;
        msg += `  • ${label}: <b>${slot.s}</b> (ថ្នាក់ ${slot.c})\n`;
      }
    }
  }
  if (!hasAny) {
    msg += `\n<i>មិនទាន់មានម៉ោងបង្រៀននៅក្នុងប្រព័ន្ធនៅឡើយទេ។</i>\n`;
  }
  return msg;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-tt-key");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Root status check
  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      school: "វិទ្យាល័យ ហ៊ុន សែន អង្គប្រីយ៍",
      bot: BOT_NAME,
      teachersLinked: Object.values(cloudData.teachers).filter(t => t.linked).length
    });
  }

  const body = req.body || {};

  // Check if Telegram Webhook update
  if (body.update_id) {
    const msg = body.message;
    const cb = body.callback_query;

    if (cb && cb.message) {
      const chatId = cb.message.chat.id;
      const data = cb.data;
      const t = Object.values(cloudData.teachers).find(x => x.chat_id === String(chatId));
      if (data === "today") {
        const day = new Date().getDay() || 7;
        await sendTelegram(chatId, t ? formatDaySchedule(cloudData.snapshot, t.id, day) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      } else if (data === "tomorrow") {
        const day = (new Date().getDay() + 1) % 7 || 7;
        await sendTelegram(chatId, t ? formatDaySchedule(cloudData.snapshot, t.id, day) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      } else if (data === "week") {
        await sendTelegram(chatId, t ? formatWeekSchedule(cloudData.snapshot, t.id) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      }
      return res.status(200).json({ ok: true });
    }

    if (msg && msg.text) {
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");

      if (text.startsWith("/start")) {
        const parts = text.split(/\s+/);
        const token = parts[1];
        if (token) {
          const t = Object.values(cloudData.teachers).find(x => x.token === token);
          if (t) {
            t.chat_id = String(chatId);
            t.tgName = fromName;
            t.linked = true;
            await sendTelegram(chatId, `🎉 <b>ភ្ជាប់បានជោគជ័យ!</b>\nជំរាបសួរលោកគ្រូ/អ្នកគ្រូ <b>${fromName}</b>!\nលោកគ្រូបានភ្ជាប់ទៅកាន់កាលវិភាគ <b>វិទ្យាល័យ ហ៊ុន សែន អង្គប្រីយ៍</b> រួចរាល់ហើយ។`, DEFAULT_KEYBOARD);
            return res.status(200).json({ ok: true });
          }
        }
      }

      const t = Object.values(cloudData.teachers).find(x => x.chat_id === String(chatId));
      if (text.includes("ថ្ងៃនេះ") || text === "/today") {
        const day = new Date().getDay() || 7;
        await sendTelegram(chatId, t ? formatDaySchedule(cloudData.snapshot, t.id, day) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      } else if (text.includes("ថ្ងៃស្អែក") || text === "/tomorrow") {
        const day = (new Date().getDay() + 1) % 7 || 7;
        await sendTelegram(chatId, t ? formatDaySchedule(cloudData.snapshot, t.id, day) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      } else if (text.includes("ទាំងសប្ដាហ៍") || text === "/week") {
        await sendTelegram(chatId, t ? formatWeekSchedule(cloudData.snapshot, t.id) : "សូមស្កេន QR ពីសាលាដើម្បីភ្ជាប់។", DEFAULT_KEYBOARD);
      } else {
        await sendTelegram(chatId, "សូមជ្រើសរើសមើលកាលវិភាគតាមប៊ូតុងខាងក្រោម៖", DEFAULT_KEYBOARD);
      }
    }
    return res.status(200).json({ ok: true });
  }

  // School Desktop App API (/api/tg/school)
  const action = body.action || "status";

  if (action === "publish" && body.snapshot) {
    cloudData.snapshot = body.snapshot;
    cloudData.snapshotAt = new Date().toISOString();
  }

  if (action === "announce") {
    for (const t of Object.values(cloudData.teachers)) {
      if (t.linked && t.chat_id) {
        await sendTelegram(t.chat_id, "📢 <b>កាលវិភាគបង្រៀនត្រូវបានធ្វើបច្ចុប្បន្នភាពថ្មី!</b>", DEFAULT_KEYBOARD);
      }
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({
    registered: true,
    bot: BOT_NAME,
    key: "key-hunsenangprei",
    link: `https://t.me/${BOT_NAME}?start=`,
    activeSchool: body.school || "413be7c3-dbb7-48b3-935a-35be6941f22b",
    schoolName: "វិទ្យាល័យ ហ៊ុន សែន អង្គប្រីយ៍",
    settings: cloudData.settings,
    teachers: Object.values(cloudData.teachers),
    snapshotAt: cloudData.snapshotAt || new Date().toISOString()
  });
};
