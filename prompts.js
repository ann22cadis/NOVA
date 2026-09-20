/**
 * NOVA Extension — centralized prompts for AI generation
 * All prompts are stored here for easy editing.
 */

/**
 * Язык ролевой: на каком языке модель пишет посты, сообщения, статусы и пересказ,
 * и на каком языке NOVA вставляет события в сам чат.
 *
 * Сами инструкции всегда на английском — меняется только язык ВЫВОДА и примеры
 * этого вывода. Всё, что зависит от языка, живёт здесь, в одном месте: и то, что
 * уходит модели, и то, что index.js пишет прямо в чат (дословная вставка, пометки
 * о переводах и картинках). Иначе половина текста переключится, а половина — нет.
 */
const RP_LANGUAGES = {
    ru: {
        code: 'ru',
        NAME: 'RUSSIAN',
        locale: 'ru-RU',
        userWord: 'Пользователь',
        playerWord: 'Игрок',
        timeExamples: '"1м", "15м", or "2ч"',
        timeShort: '1м',
        nameNote: 'can be IN RUSSIAN OR ENGLISH',
        statusExamples: '"настороженная симпатия", "давние друзья", "лучшие друзья", "бро", "влюблённость", "любовники", "заклятые враги", "как старшая сестра", "обиженное молчание"',
        statusToneExamples: 'tender ("любовники, нежные и заботливые"), wholesome ("лучшие подруги не разлей вода"), bickering ("бро, вечно подкалывают друг друга"), formal-cold ("супруги, живут будто соседи")',
        reassessStatusExamples: 'друзья, супруги, любовники, враги',
        reassessToneExamples: '"супруги, нежные и заботливые" or "бро, вечно подкалывают друг друга"',
        playlistExamples: '"Плейлист для тебя", "То, под что хочу с тобой засыпать"',
        npcDescExample: '«Сестра Ло, та самая, что упоминалась в ссоре»',
        summaryPronouns: '"you", "your", "I", "my", "вы", "вам", "ты", "мне"',
        stranger: 'незнакомец из соцсети',
        summaryExample: user => `В соцсети Кенто опубликовал новое фото. В личных сообщениях Юки написала ${user}, предложив встретиться, и ${user} согласился.`,

        // То, что index.js пишет прямо в чат РП или в историю переписки для модели
        chat: {
            units: { justNow: 'только что', minute: 'м', hour: 'ч', day: 'д', week: 'нед' },
            ago: age => `${age} назад`,
            replyFrom: label => `↳ ответ ${label}`,
            imageAttached: prompt => prompt ? `прикреплено изображение: ${prompt}` : 'прикреплено изображение',
            groupChat: (name, members) => `Групповая беседа «${name}»${members ? ` — участники: ${members}` : ''}:`,
            dmWith: label => `Переписка с ${label}:`,
            transcriptIntro: 'Ниже — дословная выгрузка из соцсети NOVA, а не пересказ.',
            threadTranscriptIntro: 'Ниже — дословная переписка из личных сообщений NOVA, а не пересказ.',
            whoIsWho: 'КТО ЕСТЬ КТО (ники в соцсети не совпадают с именами):',
            feed: 'ЛЕНТА:',
            dms: 'ЛИЧНЫЕ СООБЩЕНИЯ:',
            summaryLabel: 'События в соцсети',
            transcriptLabel: 'Переписка в соцсети',
            avatarAccepted: 'персонаж принял и уже сменил фото',
            avatarDeclined: 'персонаж отклонил',
            avatarPending: 'персонаж ещё не ответил',
            avatarSuggested: status => `[юзер предложил фото на аватар профиля; ${status}]`,
            wallpaperSet: '[юзер установил(а) новые обои в этой переписке]',
            themeSet: name => `[юзер сменил(а) тему оформления переписки на «${name}»]`,
            transferOut: (amount, to) => `игрок перевёл ${amount}${to ? ` получателю ${to}` : ''}`,
            transferIn: amount => `вам перевели ${amount}`,
            transfer: (dir, note) => `[денежный перевод: ${dir}${note ? `, комментарий: «${note}»` : ''}]`,
            // Раньше «игрок/вы» подставлялись в одну форму — выходило «игрок собрали»
            playlistShared: (fromUser, name, list) => `[${fromUser ? 'игрок собрал(а)' : 'вы собрали'} плейлист «${name}»: ${list}]`,
            trackShared: (fromUser, list) => `[${fromUser ? 'игрок поделился(ась)' : 'вы поделились'} треком: ${list}]`,
            imageInText: (text, prompt) => `${text} [прикреплено изображение${prompt ? `: ${prompt}` : ''}]`,
            imageOnly: prompt => `[прислал(а) изображение${prompt ? `: ${prompt}` : ''}]`,
        },
    },
    en: {
        code: 'en',
        NAME: 'ENGLISH',
        locale: 'en-US',
        userWord: 'User',
        playerWord: 'the player',
        timeExamples: '"1m", "15m", or "2h"',
        timeShort: '1m',
        nameNote: 'any name that fits the setting',
        statusExamples: '"cautious liking", "old friends", "best friends", "bro", "crush", "lovers", "sworn enemies", "like a big sister", "hurt silence"',
        statusToneExamples: 'tender ("lovers, gentle and caring"), wholesome ("best friends, joined at the hip"), bickering ("bros, always roasting each other"), formal-cold ("married, living like roommates")',
        reassessStatusExamples: 'friends, spouses, lovers, enemies',
        reassessToneExamples: '"married, gentle and caring" or "bros, always roasting each other"',
        playlistExamples: '"A playlist for you", "What I want to fall asleep to with you"',
        npcDescExample: '"Law\'s sister — the one who came up during the fight"',
        summaryPronouns: '"you", "your", "I", "my"',
        stranger: 'a stranger from the social feed',
        summaryExample: user => `On the social feed, Kento posted a new photo. In private messages, Yuki texted ${user} suggesting they meet up, and ${user} agreed.`,

        chat: {
            units: { justNow: 'just now', minute: 'm', hour: 'h', day: 'd', week: 'w' },
            ago: age => `${age} ago`,
            replyFrom: label => `↳ reply from ${label}`,
            imageAttached: prompt => prompt ? `image attached: ${prompt}` : 'image attached',
            groupChat: (name, members) => `Group chat "${name}"${members ? ` — members: ${members}` : ''}:`,
            dmWith: label => `Private chat with ${label}:`,
            transcriptIntro: 'Below is a verbatim export from the NOVA social feed, not a summary.',
            threadTranscriptIntro: 'Below is a verbatim export of a NOVA private chat, not a summary.',
            whoIsWho: 'WHO IS WHO (social media handles are not the same as names):',
            feed: 'FEED:',
            dms: 'PRIVATE MESSAGES:',
            summaryLabel: 'Social media events',
            transcriptLabel: 'Social media transcript',
            avatarAccepted: 'the character accepted and already changed their photo',
            avatarDeclined: 'the character declined',
            avatarPending: 'the character has not answered yet',
            avatarSuggested: status => `[the user suggested a new profile photo; ${status}]`,
            wallpaperSet: '[the user set a new wallpaper for this chat]',
            themeSet: name => `[the user changed this chat's theme to "${name}"]`,
            transferOut: (amount, to) => `the player sent ${amount}${to ? ` to ${to}` : ''}`,
            transferIn: amount => `you received ${amount}`,
            transfer: (dir, note) => `[money transfer: ${dir}${note ? `, note: "${note}"` : ''}]`,
            playlistShared: (fromUser, name, list) => `[${fromUser ? 'the player' : 'you'} shared a playlist "${name}": ${list}]`,
            trackShared: (fromUser, list) => `[${fromUser ? 'the player' : 'you'} shared a track: ${list}]`,
            imageInText: (text, prompt) => `${text} [image attached${prompt ? `: ${prompt}` : ''}]`,
            imageOnly: prompt => `[sent an image${prompt ? `: ${prompt}` : ''}]`,
        },
    },
};

const DEFAULT_RP_LANGUAGE = 'ru';

/** Текущий язык ролевой — читается из настроек на каждый вызов, чтобы не рассинхронизироваться. */
function rp() {
    const code = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.NOVA?.rp_language;
    return RP_LANGUAGES[code] || RP_LANGUAGES[DEFAULT_RP_LANGUAGE];
}

export const NovaPrompts = {

    /** Языковой пакет текущей ролевой — index.js берёт отсюда всё, что пишет в чат. */
    rp,

    /** Все подписи блоков в чате на всех языках: блок, вставленный на одном языке, должен находиться и после переключения. */
    allContextLabels() {
        return Object.values(RP_LANGUAGES).flatMap(l => [l.chat.summaryLabel, l.chat.transcriptLabel]);
    },

    isTranscriptLabel(label) {
        return Object.values(RP_LANGUAGES).some(l => l.chat.transcriptLabel === label);
    },

    /**
     * Блок про фотографии для промптов ленты и личных сообщений.
     *
     * Разделение намеренное: КОНТРАКТ (имя поля, язык, длина) задаётся здесь, в коде,
     * а художественная часть — стиль, поводы, настроение — приходит из пресета,
     * который пользователь правит в настройках. Так пользователь не может случайно
     * сломать разбор JSON, переписывая свой стиль.
     *
     * @param {object} opts
     * @param {number} opts.maxImages — потолок картинок за одну генерацию (0 — выключено)
     * @param {'feed'|'dm'} opts.target — куда прикладывается фото
     * @param {string} opts.allowedHandles — кому фото разрешено; пусто — ограничений нет
     * @param {string} opts.protocol — пресет: ЧЕМ заполнять тег, пишет пользователь
     * @param {string} opts.style — активный стиль картинки: приложение добавляет его
     *   к КАЖДОМУ запросу само, модель своё поле "style" не заполняет
     * @param {boolean} opts.withReferences — приложен ли референс внешности
     */
    imageInstructionBlock({ maxImages = 0, target = 'feed', allowedHandles = '', protocol = '', style = '', withReferences = false } = {}) {
        if (!maxImages || maxImages < 1) return '';
        const L = rp();

        const where = target === 'dm'
            ? 'A message object may carry a photo.'
            : 'A post object may carry a photo.';

        // Единственное содержательное правило, которое обязано жить в коде:
        // пользователь не может знать заранее, доедет ли референс до генератора,
        // а от этого зависит, описывать внешность словами или нет
        const appearance = withReferences
            ? `- A REFERENCE PHOTO of the character goes with the request. Do NOT describe hair colour, eye colour, skin tone, face shape or body build — they are copied from the reference, and words only fight it.`
            : `- No reference photo is attached, so appearance has to be described in words, or the same character comes out as a different person every time.`;

        return `

PHOTOS (image generation is ON):
${where} STRICT FORMAT — this part is fixed and not up for interpretation:

- Put this tag at the very END of the object's own "text". It is read and removed before the post is shown:
  <img data-iig-instruction='{\\"prompt\\":\\"[PROMPT IN ENGLISH]\\",\\"aspect_ratio\\":\\"3:4\\",\\"image_size\\":\\"2K\\"}' src="[IMG:GEN]">
- The JSON stays on ONE line. Single quotes around the whole object. This tag lives INSIDE a JSON string value (the object's own "text" field) — so every double quote inside it MUST be backslash-escaped (\\") exactly like the example above, or the whole response becomes invalid JSON and gets thrown away entirely. No literal newlines. Keep src="[IMG:GEN]" exactly as written.
- "aspect_ratio" accepts only: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. "image_size" accepts only: 1K, 2K, 4K. Anything else is replaced by the app's own setting.
- There is NO "style" field: the app adds its own configured visual style to EVERY photo by itself. Never write a style field or restate a style in "prompt".
- "prompt" is ENGLISH, one dense paragraph, no line breaks, no URLs, no file paths, no markdown. It is handed to an image generator that sees NOTHING else — not this post, not the chat, not the character cards.
- Equivalent alternative: instead of the tag, put the field "image_prompt": "..." on the object. Use ONE of the two, never both.
- The object's own "text" stays IN ${L.NAME} and reads like a caption next to the photo, never a description of it.
- AT MOST ${maxImages} object${maxImages === 1 ? '' : 's'} in this whole response may carry a photo. Anything beyond that is dropped.
- No photo to send right now — no tag and no field. An empty or placeholder value is a FAILURE.
${appearance}${allowedHandles ? `
- ONLY these accounts may carry a photo: ${allowedHandles}. On anyone else it is dropped.` : ''}${protocol ? `

WHAT TO PUT IN "prompt" — the user's own rules, follow them:
${protocol}` : ''}${style ? `

VISUAL STYLE (added to every photo automatically — for your information only, never restate it in "prompt"):
${style}` : ''}`;
    },

    /**
     * Блок про скрытое отслеживание симпатии — только для аккаунтов, которых
     * пользователь явно отметил во вкладке «Отношения». Тег живёт в самом тексте
     * поста/сообщения и вырезается перед показом, как и тег фото.
     *
     * Тег опционален в ленте (иначе даже болтовня с кем-то третьим двигала бы
     * симпатию к юзеру и превращалась в шум), но в личке — почти обязателен:
     * там КАЖДОЕ сообщение уже адресовано юзеру самим фактом переписки.
     * @param {string} opts.trackedHandles — через запятую, кого отслеживаем
     * @param {string} opts.newHandles — подмножество trackedHandles без единой
     *   записи ещё — для них отдельно просим стартовую оценку по контексту РП
     * @param {string} opts.userHandle — хэндл пользователя, к которому меняется симпатия
     * @param {'feed'|'dm'|'feed-reaction'} opts.target — где именно это разворачивается.
     *   'feed-reaction' — не обычное обновление ленты, а батч, целиком состоящий
     *   из реакций на ОДИН конкретный пост юзера (создание поста, перегенерация) —
     *   тут строгая избирательность 'feed' не нужна, это и так сплошь реакции.
     */
    relationshipInstructionBlock({ trackedHandles = '', newHandles = '', userHandle = '@user', target = 'feed' } = {}) {
        if (!trackedHandles) return '';
        const L = rp();
        const relevance = target === 'dm'
            ? `This is a private DM, so almost every message from a tracked account here already counts as a reaction to ${userHandle} — the tag should usually be present (even with "affinity_delta":0) rather than skipped. Only skip it for something that isn't really a reaction at all, like a lone sticker or a system-style notice.`
            : target === 'feed-reaction'
            ? `Every post in this batch is a reaction to ONE specific thing ${userHandle} just posted — this is not a normal feed refresh full of unrelated chatter, it IS the reactions. The tag should usually be present here too (even with "affinity_delta":0) rather than skipped.`
            : `SKIP the tag ENTIRELY when the object has nothing to do with ${userHandle} — banter with someone else, an unrelated feed post, small talk in a group chat that doesn't touch them. Most objects, even from tracked accounts, will NOT carry this tag. Putting it on everything is wrong and exactly what NOT to do.`;
        return `

RELATIONSHIP TRACKING (only for these accounts, and only when it genuinely applies): ${trackedHandles}
When an object above is written BY one of these accounts AND it is a direct reaction to ${userHandle} — a reply to something ${userHandle} said or did, a DM to them, a post clearly about them — add a hidden tag at the very END of that object's own "text" (same rule as the photo tag: removed before the post is shown, never mentioned in the visible text itself):
<span data-nova-relationship='{\\"affinity_delta\\":0,\\"status\\":\\"\\",\\"reaction\\":\\"[ONE SHORT SENTENCE, ${L.NAME}]\\"}'></span>
- This tag lives INSIDE a JSON string value (the object's own "text" field) — every double quote inside it MUST be backslash-escaped (\\") exactly like the example above, or the whole response becomes invalid JSON and gets thrown away entirely.
- ${relevance}
- "affinity_delta": a NUMBER from -10 to 10, with up to ONE decimal place (0.5, -1.5, 3, -7 are all valid), how THIS exchange shifted their feelings toward ${userHandle}. 0 is a completely normal, common answer — most small talk, routine replies, or reactions that are worth a line but don't actually move the needle should get 0. Do NOT invent movement just to have a non-zero number. Use a fractional value (±0.5, ±1.5) for something that barely registers but isn't quite nothing — a small wave of your existing whole-number scale, not a separate category. Keep real whole-number swings small (±1 to ±3) too; reserve ±7 to ±10 for a genuinely major moment (betrayal, huge favor, confession).
- "status": OPTIONAL, one short phrase in ${L.NAME} capturing the relationship right now — not just HOW STRONG it is, but what KIND it actually is. Romance, rivalry, family-like bonds, mentorship — whatever the story has actually built, not only degrees of friendship (e.g. ${L.statusExamples}). Fill it in only when it's worth being more specific than the raw number; otherwise leave it "". Unlike "reaction" below, this is a stable label for what they ARE to each other — it should persist across many exchanges, not get rewritten on every single tag. Feel free to colour the label with the actual TONE of the dynamic instead of leaving it a flat, one-word category that never changes — ${L.statusToneExamples} are all fair game when that's genuinely how it plays out.
- "reaction": ONE short sentence in ${L.NAME}, in the character's own voice — how they feel about ${userHandle} right now, not a summary of the scene. Can be funny, petty, warm, sarcastic — whatever actually fits the character.${newHandles ? `

FIRST-TIME CALIBRATION for these accounts specifically (no relationship data recorded for them yet): ${newHandles}
On THEIR first tagged reaction, don't treat them as if meeting ${userHandle} for the first time — look at everything already established between them and ${userHandle} in this roleplay so far (history, how they already talk to each other, any existing dynamic) and add one more field to the tag: "affinity_estimate", an absolute integer 0-100 for where things realistically stand RIGHT NOW (50 = neutral strangers, 80+ = established friends or more, 20 or below = real hostility). This is a one-time starting point, not a delta — do this only the first time each of these accounts gets tagged, never again after.` : ''}`;
    },

    /**
     * Ручной пересчёт симпатии одной кнопкой — на случай, если авто-калибровка при
     * первом теге промахнулась мимо очевидного из карточки/сюжета (пример из жизни:
     * супруг стартовал с нейтральных 50%, хотя они женаты по сценарию). В отличие
     * от relationshipInstructionBlock тут не дельта, а прямая перезапись числа —
     * отдельный вызов модели, не часть промпта ленты/ЛС.
     * @param {string} profileInfo — карточка персонажа, тем же форматом, что и в остальных промптах
     * @param {string} chatContext — весь доступный контекст ролеплея
     * @param {string} userHandle — хэндл пользователя, к которому оценивается симпатия
     */
    relationshipReassessPrompt(profileInfo, chatContext, userHandle) {
        const L = rp();
        return `You are analyzing a roleplay to assess a relationship.

CRITICAL: write "status" and "reason" below in ${L.NAME}, REGARDLESS of what language the character profile or the roleplay context below are written in.

The character being assessed:
${profileInfo}

FULL ROLEPLAY CONTEXT SO FAR:
${chatContext}

TASK: Based on EVERYTHING established above between this character and ${userHandle} — their history, how they actually talk to each other, any explicit relationship stated in the character card or scenario (spouse, sibling, rival, complete stranger, etc.) — assess where their relationship realistically stands RIGHT NOW. This replaces whatever number is currently stored, so be accurate rather than conservative.

Output ONLY this JSON object, nothing before or after it:
{"affinity": [integer 0-100, where 50 = neutral strangers, 80+ = established closeness or more, 20 or below = real hostility], "status": "[one short phrase in ${L.NAME} naming what they ARE to each other right now — ${L.reassessStatusExamples}, etc. — or empty string if truly nothing is established yet. Colour it with the actual tone of the dynamic rather than a flat one-word category: tender, wholesome, bickering, formal-cold — whichever genuinely fits, e.g. ${L.reassessToneExamples}]", "reason": "[ONE short sentence in ${L.NAME} explaining the estimate, in plain narration, not in character]"}`;
    },

    /**
     * Блок про предложенное фото на аватар (Telegram-style "suggest profile photo") —
     * добавляется только когда в треде реально висит НЕРЕШЁННОЕ предложение.
     */
    avatarSuggestionInstructionBlock() {
        return `

PROFILE PHOTO SUGGESTION: the user just sent a photo (attached to this message, look at it) suggesting it become YOUR new profile picture. This is entirely your character's own call — accept if it actually fits them and the moment, decline if it doesn't; react however genuinely suits their personality (touched, annoyed, amused, suspicious, whatever fits).
Put a hidden tag at the very END of your reply's "text" (removed before the message is shown, never mentioned in the visible text itself):
<span data-nova-avatar-decision='{\\"accept\\":true}'></span>
- "accept": true if your character is changing their photo to this one, false if not.
- This tag lives INSIDE a JSON string value (the reply's own "text" field) — every double quote inside it MUST be backslash-escaped (\\") exactly like the example above, or the whole response becomes invalid JSON and gets thrown away entirely.
- This tag is REQUIRED in this reply — always include it, one way or the other, even if your visible reply doesn't spell out the decision in words.`;
    },

    /**
     * Блок про музыку (MoodTube, стороннее расширение) — добавляется только когда
     * оно реально подключено в этой сессии (проверяет вызывающий код на стороне
     * NOVA). Тег не про КАЖДЫЙ пост — редкий, только когда персонаж реально делится
     * треком/плейлистом, а не просто упоминает музыку в разговоре.
     */
    musicInstructionBlock({ recentTracks = '' } = {}) {
        const L = rp();
        return `

MUSIC (MoodTube is connected — a character can queue up a real track to actually play): when it genuinely fits — a character is DJing, sharing a song that matches their mood, sending a track to someone — add a hidden tag at the very END of that object's own "text" (removed before the post is shown, never mentioned in the visible text itself):
<span data-nova-music='{\\"tracks\\":[\\"Artist - Song Title\\"],\\"playlist_name\\":\\"\\",\\"note\\":\\"\\"}'></span>
- "tracks": real search queries, each as "Artist - Title" (or a clear title/mood phrase if there's no clean artist match). These are handed to an actual music player — keep them accurate and searchable, not vague or invented nonsense.
- "playlist_name": OPTIONAL, in ${L.NAME}, in the character's own words (e.g. ${L.playlistExamples}) — fill this in ONLY when the character is deliberately sharing a curated PLAYLIST, not a single song. When "playlist_name" is filled in, "tracks" must have 5 to 20 real songs. When it's an ordinary one-or-a-few-song share, leave "playlist_name" "" and keep "tracks" to 1-4.
- "note": OPTIONAL, one short phrase in ${L.NAME} on why this fits right now — leave "" if the visible text already makes it obvious. Skip it when "playlist_name" is filled in and the visible text already explains the playlist.
- This is RARE — most posts and messages have nothing to do with music. Only use it when a character is genuinely sharing or playing something, never as background commentary. A full named playlist is rarer still than a single-track share — most music moments are just one song.
- PICK THE TRACK FROM THE CHARACTER, not from what's statistically obvious. Base it on THIS character's actual taste, era, mood, culture, or the scene's specific vibe (their card, their established interests, what they'd realistically have on their phone) — not the single most famous song of a genre that any model would default to, and NOT the same reflex pick ("Do I Wanna Know?" by Arctic Monkeys, or any other overused go-to) every character seems to reach for. Two different characters should essentially never land on the same song unless the scene explicitly calls for it (e.g. one is directly reacting to what the other just sent).${recentTracks ? `
- ALREADY SHARED IN THIS STORY — do not pick any of these again, they are used up: ${recentTracks}` : ''}`;
    },

    /**
     * Юзер физически не может сам приложить сгенерированное фото или собрать
     * карточку трека/плейлиста — это либо настоящая генерация картинки, либо
     * разметка, которую до сих пор строила только модель для СВОИХ сообщений.
     * Когда юзер вводит команду (/фото, /музыка, /плейлист), этим блоком просим
     * модель одним заходом оформить ЕГО сообщение тем же тегом, что и свои
     * собственные, и сразу же отреагировать в характере — вместо двух отдельных
     * запросов (сначала карточка, потом отдельно реакция).
     *
     * Данные (описание фото, названия треков) уже разобраны на стороне приложения
     * (см. parseUserDMCommand в index.js) и передаются сюда готовыми — модель не
     * досочиняет и не переслушивает названия треков, только оборачивает их в тег
     * и пишет текст.
     * @param {{type: 'photo'|'music'|'playlist', description?: string, tracks?: string[], playlistName?: string}} command
     */
    userCommandInstructionBlock(command) {
        if (!command) return '';

        // Само сообщение игрока (карточку трека, плейлист, слот под фото) строит
        // приложение — модель его НЕ пишет и не пересказывает. Раньше просили
        // вернуть его отдельным объектом с "from_user":true, и модель регулярно
        // промахивалась: дословно повторяла введённую команду ("/фото ...") как
        // реплику игрока и вешала фото на СВОЁ сообщение вместо его. Теперь от неё
        // нужен максимум один короткий текстовый ПОЛЕМ — промпт для фото, — а всё
        // остальное собрано детерминированно на нашей стороне.
        if (command.type === 'photo') {
            return `

THE PLAYER IS SENDING YOU A PHOTO RIGHT NOW. Their own description of what is in it, in their words: "${command.description}"
The photo is already placed in the conversation as the player's own message — do NOT write their message for them, do NOT repeat their words back, and do NOT put this photo on one of YOUR messages. It is theirs, and it is already there.

Two things are required of you:
1. Add a top-level field "user_photo" to your JSON response — the SAME fields you would put in your own photo tag, just as a plain object instead of the <img> tag markup (there is no surrounding message text to embed it in here, the player's message is handled separately):
{"prompt": "[PROMPT IN ENGLISH]", "aspect_ratio": "3:4", "image_size": "2K"}
Same rules as your own photos: "prompt" is English, one dense paragraph — expand the player's short description into a real prompt (setting, framing, lighting, what is actually visible). It is a photo taken by or of the PLAYER, so frame it that way. "aspect_ratio" only from: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 — pick whatever actually suits THIS photo (a selfie is usually vertical, not square). "image_size" only: 1K, 2K, 4K. There is no "style" field — the app applies its own visual style to every photo, same as for your own.
2. In "messages", write ONLY your own character's reaction to receiving this photo — react to what is actually in it, the way a real person reacts to a photo a friend just sent. Do not merely acknowledge that a photo arrived.`;
        }

        const what = command.playlistName
            ? `a PLAYLIST named "${command.playlistName}" containing these tracks, typed exactly as the player wrote them: ${JSON.stringify(command.tracks)}`
            : `this track, typed exactly as the player wrote it: ${JSON.stringify(command.tracks)}`;
        const tracksJson = JSON.stringify(command.tracks);

        return `

THE PLAYER JUST SENT YOU ${command.playlistName ? 'A PLAYLIST' : 'A TRACK'} — ${what}
It is already placed in the conversation as the player's own message, as a real playable card. Do NOT write the player's message for them, do NOT repeat it back, and do NOT attach a music tag of your own for these same tracks — that would duplicate what they just sent.

Two things are required of you:
1. Add a top-level field "user_tracks" to your JSON response: an array of EXACTLY ${command.tracks.length} string${command.tracks.length === 1 ? '' : 's'}, same order as ${tracksJson}. The player may have typed these casually or with a typo (lowercase, no punctuation, a nickname) — for each one, if you can confidently identify the real song, correct it to a clean, accurate "Artist - Title" search string; if you genuinely cannot tell what it refers to, keep the player's own wording for that entry unchanged rather than guessing at a different song. Never invent a track that is not what the player actually typed, and never add, drop, merge or reorder entries — the count and order must match exactly, or the correction is discarded entirely.
2. In "messages", write ONLY your own character's reaction to receiving this — react to the actual ${command.playlistName ? 'playlist, by its name and what is in it' : 'song, by name'} (use the corrected title in your reaction, not the player's raw typo), the way a real person reacts to music a friend just sent them. Do not merely acknowledge that it arrived.`;
    },

    /**
     * Feed Generation — main prompt.
     * @param {string} profilesInfo  — list of profiles (characters + NPCs)
     * @param {string} chatContext   — chat context (persona, character card, history)
     * @param {string|null} userPostText — if user posted a text, otherwise null
     * @param {string} imageInstruction — блок про фото, см. imageInstructionBlock()
     */
    generateFeed(profilesInfo, chatContext, userPostText = null, userHandle = '@user', recentDMsContext = '', recentPostsContext = '', hasUserImage = false, imageInstruction = '') {
        const L = rp();
        const imageNote = hasUserImage
            ? `\nThe user attached an IMAGE to this post — it is included in this request. React to what is ACTUALLY visible in it: reply to the picture, not to a generic idea of one. Do not describe the image back; respond to it the way people reply to a photo online.`
            : '';

        // Модель и так смотрит на приложенное фото, чтобы написать реакции на него —
        // просим заодно вернуть короткое описание в том же ответе. Бесплатно: не
        // отдельный запрос, а ещё одно поле в уже идущем. Показывается той же кнопкой
        // «промпт» у картинки, что и для сгенерированных фото.
        const captionField = hasUserImage
            ? `, "image_caption": "one SHORT sentence in ${L.NAME} describing what is actually in the photo — for the user's own reference, not shown to characters"`
            : '';

        const actionSection = userPostText || hasUserImage
            ? `ACTION: The user just posted: "${userPostText || '(image only, no text)'}".${imageNote}
EXCEPTION TO THE RULE: You MUST output the User's post as the FIRST item in the "posts" array exactly like this: {"author_handle": "${userHandle}", "text": "${userPostText || ''}"${captionField}}. Then, generate an active thread of REPLIES to this first post from other characters. After that, generate the rest of the feed as usual.`
            : `ACTION: Generate a fresh feed. Time has passed since the last batch — the world moved on WITHOUT waiting for the user.`;

        return `You are the core engine of the "NOVA" social media simulation (similar to X/Twitter) inside a Roleplay universe.
Your goal is to create a LIVE, IMMERSIVE, and DYNAMIC feed that reflects the ongoing story events.

CRITICAL INSTRUCTIONS:
- ALL GENERATED TEXT (posts, messages) MUST BE IN ${L.NAME} LANGUAGE.
- You MUST ACTIVELY USE characters from the chat and NPCs from the list below.
- Characters from the current chat MUST be at the center of events if something important is happening in the RP.
- DO NOT generate posts or DMs on behalf of the USER / PLAYER. The user writes their own posts. Never use the User's handle in "author_handle".
- IMPORTANT: "${L.userWord}" (or whatever name is set in the User's profile) refers to ME — the real, active participant in this roleplay whom the characters are addressing. Treat my actions as those of a full participant in the story, not a passive observer.
- Mix different tones: shitposting, drama, reactions to RP events, personal thoughts, interactions (replies/quotes).
- Posts must REFLECT THE PERSONALITY of the character according to their character card and the current scene.

TWO DIFFERENT KINDS OF PEOPLE POST HERE — DO NOT TREAT THEM THE SAME:

A) BACKGROUND NPCs (marked as NPC in the profile list) — they have their own lives:
- They are NOT in the RP scene. They are elsewhere, doing their own thing.
- Their posts should mostly have NOTHING to do with the RP: work shifts, broken appliances, food, sleep, money, commutes, weather, games, music, gym, exams, family, pets, bad dates, online arguments about nothing.
- Give them ongoing private storylines that CONTINUE across batches and never involve the user. Advance them a step each time.
- They interact WITH EACH OTHER about their own business, not only about the user.

B) CHARACTERS FROM THE CURRENT CHAT — they are INSIDE the RP scene RIGHT NOW:
- Their posts MUST be consistent with where they are, who they are with, and what they are doing in the RP at this exact moment.
- If the RP has them sitting next to the user, they post FROM there — bored, amused, sneaking a photo, complaining under their breath. They do NOT announce they are travelling to the user, waking up, or arriving somewhere they already are.
- They may post about their own thoughts, chores or moods, but NEVER anything that contradicts the current scene.

HARD CONSISTENCY RULES — breaking any of these is a FAILURE:
- The feed happens at the CURRENT moment of the RP. Do NOT skip ahead, do not invent days passing, do not resolve events that have not happened yet in the chat.
- Never write that someone is going somewhere they are already at, or is away from someone they are currently with.
- Never invent major events for chat characters that the RP has not shown. Small everyday details are fine; plot is not.
- If you are unsure where a chat character is, keep their post vague and mundane rather than inventing a location.

NEVER REPEAT YOURSELF (but never let this reduce the amount you write):
- The feed below shows what has ALREADY been posted. Do not restate any of it in new words.
- If a topic already appeared, advance it to a NEW stage — consequence, resolution, someone else's take.
- Vary the openings. Do not start multiple posts with the same word or construction.
- If you struggle to find a new angle, invent a NEW mundane event in that character's day. There is always something new. Writing fewer posts is NOT an acceptable way to avoid repeating.

CURRENT RP CONTEXT (This dictates the themes of the posts — READ CAREFULLY):
${chatContext}

AVAILABLE PROFILES (STRICTLY use handles from this list):
${profilesInfo}

>>> THE USER'S ACCOUNT IS ${userHandle} <<<
This one account belongs to the human player — the person reading this feed.
- NEVER put ${userHandle} in "author_handle" of a post or a reply, at any nesting level.
- NEVER write words, opinions, reactions or decisions on the player's behalf.
- Everyone else reacts TO ${userHandle}; ${userHandle} never speaks here on their own.
- If you catch yourself about to write a line for ${userHandle}, give it to a different character instead.

${recentPostsContext ? `ALREADY POSTED — DO NOT REPEAT ANY OF THIS (newest first):\n${recentPostsContext}\n\n-> Every theme, joke and turn of phrase above is used up. Bring topics that are NOT in this list.` : ''}

${actionSection}

${recentDMsContext ? `RECENT DM HISTORY (Current private conversations):\n${recentDMsContext}\n\n-> IMPORTANT: If you choose to generate a "dm", it MUST logically continue the conversation based on the history above, or be a highly relevant reaction to the current RP scene. Do not generate random/empty messages just to say hi. If there is no strong reason to send a DM right now, return null for "dm".
-> Entries marked GROUP CHAT are group conversations with a name and a member list. To write into one, set "group_handle" to its group_handle AND "author_handle" to the specific member who is speaking. Address the group by its name and stay on whatever the group is actually about.
-> A "dm" WITHOUT a "group_handle" is a one-on-one private chat between "author_handle" and ${userHandle} — nobody else can see it or speak in it. Write it as that character talking TO ${userHandle} directly. Characters gossiping with EACH OTHER does not belong here: put that in a group chat, or in the replies under a post. A one-on-one "dm" whose text is aimed at a third person, or which contains lines from more than one speaker, is a FAILURE.
-> NEVER write the speaker's name or handle inside "text" — the app renders the sender itself. Text starting with something like "[@someone]:" is a FAILURE.` : `-> If someone has an urgent secret reaction to the events, you may generate a "dm". Otherwise return null. A "dm" without a "group_handle" is a private one-on-one message written TO ${userHandle} — not two characters talking to each other.`}

STRICT JSON FORMAT:
{
    "elapsed_minutes": number — how much IN-STORY time the CHAT ITSELF has moved since the previous batch. This REPORTS what the RP already shows; it does NOT give you permission to invent a time skip. If the scene is still going, it is 15-60. Only use hours or days when the chat itself clearly jumped ahead. When in doubt, use 30.
    "posts": [
        { 
            "author_handle": "@handle", 
            "text": "Post content IN ${L.NAME}. Match the character's personality/style. DO NOT use hashtags unless it is deeply ingrained in the character's core personality. Do not spam tags.",
            "likes": number,
            "retweets": number,
            "time": ${L.timeExamples},
            "replies": [
                {
                    "author_handle": "@reply_handle",
                    "text": "Reply text IN ${L.NAME}",
                    "likes": number,
                    "time": "...",
                    "replies": [
                        // Optional: You CAN and SHOULD nest replies here if characters are replying directly to THIS reply instead of the main post!
                    ]
                }
            ]
        }
    ],
    "dm": {
        "author_handle": "@handle",
        "group_handle": "@group_xxxx or omit",
        "text": "A private message IN ${L.NAME}. Must make sense in the context of recent DMs. Or null if no DM."
    }
}

INSTRUCTIONS:
1. Generate 6-10 MAIN posts (the top-level 'posts' array should have 6-10 objects).
2. Ensure that at least 50% of the posts belong to the Characters from the chat (if available). This is about WHO posts, not WHAT about — those characters also have jobs, chores and moods unrelated to the scene.
3. EVERY POST MUST HAVE REPLIES. You MUST vary the number of replies wildly (e.g., Post 1 gets 8 replies, Post 2 gets 4, Post 3 gets 11, Post 4 gets 5). DO NOT be lazy and do not default to 3 replies for everything. Any post with exactly 3 replies is considered a FAILURE unless it's the only one.
4. If characters are replying to EACH OTHER's comments, you MUST put their replies inside the nested "replies" array of that specific comment. This creates deep conversation threads!
5. If the RP context is tense, let that leak into the feed — but only for those actually involved. Everyone else is still busy with their own day.
6. Use the personality and description of characters from their cards — posts must sound EXACTLY LIKE THEM.
7. If the RP context has NOT changed since the posts listed above, do NOT re-cover it. Lean almost entirely on the NPCs' own lives and on time simply passing.
8. Before writing, pick a DIFFERENT topic for each post. If two posts would be about the same thing, replace one.

FINAL CHECK BEFORE YOU OUTPUT — non-negotiable:
- The "posts" array MUST contain AT LEAST 6 objects. Returning fewer than 6 is a FAILURE, no matter how hard the no-repeat rule felt.
- EVERY post must have a non-empty "replies" array, with wildly varying counts.
- Output ONLY the JSON object. Nothing before it, nothing after it.${imageInstruction}`;
    },

    /**
     * Generate a reply to a specific post/reply in the feed.
     * @param {string} profilesInfo  — list of profiles (characters + NPCs)
     * @param {string} chatContext   — chat context
     * @param {string} originalPostText — the text of the post/reply being replied to
     * @param {string} userReplyText — the text the user just posted as a reply
     * @param {string} targetHandle  — the handle of the character the user replied to
     * @param {string} relationshipInstruction — блок про симпатию, см. relationshipInstructionBlock()
     */
    generateFeedReply(profilesInfo, chatContext, originalPostText, userReplyText, targetHandle, userHandle = '@user', relationshipInstruction = '') {
        const L = rp();
        return `You are the core engine of the "NOVA" social media simulation inside a Roleplay universe.
Your goal is to simulate how characters would react to the User's reply.

CRITICAL INSTRUCTIONS:
- ALL GENERATED TEXT MUST BE IN ${L.NAME} LANGUAGE.
- DO NOT generate posts on behalf of the USER / PLAYER (${userHandle}).
- You MUST ACTIVELY USE characters from the chat and NPCs from the list below.
- IMPORTANT: "${L.userWord}" (User) refers to the real person playing this roleplay. Treat their actions as those of a full participant in the story.

CURRENT RP CONTEXT:
${chatContext}

AVAILABLE PROFILES (STRICTLY use handles from this list):
${profilesInfo}

>>> THE USER'S ACCOUNT IS ${userHandle} <<<
This one account belongs to the human player — the person reading this feed.
- NEVER put ${userHandle} in "author_handle" of a post or a reply, at any nesting level.
- NEVER write words, opinions, reactions or decisions on the player's behalf.
- Everyone else reacts TO ${userHandle}; ${userHandle} never speaks here on their own.
- If you catch yourself about to write a line for ${userHandle}, give it to a different character instead.

ACTION: 
The User just replied to a post by ${targetHandle}.
Original Post: "${originalPostText}"
User's Reply: "${userReplyText}"

YOUR TASK:
1. You MUST generate a direct reply from ${targetHandle} reacting to the User's reply.
2. You must generate additional replies from other characters joining the thread.
3. DO NOT generate standalone posts for the main feed, only replies relevant to the current thread.
STRICT JSON FORMAT:
{
    "posts": [
        { 
            "author_handle": "@handle", 
            "text": "Post content IN ${L.NAME}",
            "likes": number,
            "retweets": number,
            "time": "${L.timeShort}",
            "replies": [
                {
                    "author_handle": "@reply_handle",
                    "text": "Reply text IN ${L.NAME}",
                    "likes": number,
                    "time": "...",
                    "replies": [
                        // Optional: Nest replies here if someone is replying directly to this comment!
                    ]
                }
            ]
        }
    ]
}

INSTRUCTIONS:
1. The FIRST item in the "posts" array MUST be the direct reaction of ${targetHandle} to the User's reply ("${userReplyText}").
   - It MUST NOT be authored by the User.
   - Include replies under it in the "replies" array if other characters join this specific sub-thread.
2. If characters argue or reply to EACH OTHER, use the nested "replies" array inside their comments to form deep threads.
3. You MAY generate additional items in the "posts" array. These represent OTHER characters independently replying to the ORIGINAL POST or discussing it.
   - DO NOT generate posts for the main feed, ONLY generate replies relevant to the current thread.${relationshipInstruction}`;
    },

    /**
     * Generate an NPC folder based on chat context.
     * @param {string} chatContext — context from chat
     * @param {string} note — необязательное указание пользователя (ООС): чего он
     *   хочет от этой пачки NPC. Идёт ПОСЛЕ контекста и правил, но перед форматом
     *   вывода — так оно перебивает общие правила, не ломая контракт JSON.
     */
    generateNPCFolder(chatContext, note = '') {
        const L = rp();
        const noteBlock = String(note || '').trim() ? `

DIRECT INSTRUCTION FROM THE PLAYER — this is an out-of-character request about the NPCs you are about to create. It OVERRIDES the general guidance above wherever they disagree (how many NPCs, who they should be, their tone, the theme of the folder). Follow it literally, but keep the output format and the language rules intact:
${String(note).trim()}` : '';

        return `You are a creative AI. Carefully analyze the CURRENT RP CONTEXT below:
- Pay special attention to the USER PERSONA — this describes the player.
- Pay special attention to the CHARACTER CARDS — these are the main actors in the story.
- Consider the setting, lore, country, atmosphere, and story style.

YOUR PRIMARY JOB IS EXTRACTION, NOT INVENTION.

STEP 1 — HARVEST THE CONTEXT FIRST. Re-read the RP context and list every person who is MENTIONED but is not the player and not a main character card:
- People named outright (a friend, a sibling, an ex, a boss, a classmate, a rival, a neighbour).
- People referred to without a name ("her mother", "that guy from the bar", "his coworker", "the teacher who failed me") — give them a fitting name.
- People implied by the setting or the characters' jobs, school, family or history.
These MUST become NPCs, and they come FIRST in the list. Their "desc" MUST reference the specific thing the RP said about them, so the connection is obvious.

STEP 2 — ONLY THEN invent. If the harvest gives you fewer than 5 people, invent additional background characters to fill the gap — but they must plausibly belong to the same city, school, workplace or scene, not generic internet strangers.

A folder made only of invented characters, ignoring people the RP already mentioned, is a FAILURE.
They should feel alive, slightly chaotic/toxic, and have a Twitter-like posting style.

IMPORTANT: ALL GENERATED TEXT (folder name, NPC names, descriptions, styles) MUST BE IN ${L.NAME} LANGUAGE (except handles and seeds).
OUTPUT ONLY VALID JSON. No conversational text. Do not use real human faces for avatars.

CURRENT RP CONTEXT:
${chatContext}

INSTRUCTIONS:
1. "folder_name": A thematic name for this group of NPCs IN ${L.NAME}, directly related to the current story and characters.
2. "npcs": An array of NPC objects. Generate as many as appropriate for the context (from 3 to 10).
   - "name": Character's name (${L.nameNote}). Must logically fit the country and setting.
   - "handle": Username starting with @ (STRICTLY LATIN LETTERS).
   - "desc": A short description of who they are and what they post IN ${L.NAME}. For a harvested person, STATE THEIR CONNECTION explicitly — who they are to the characters and what the RP said about them (e.g. ${L.npcDescExample}). For an invented one, tie them to the setting.
   - "style": Their posting style IN ${L.NAME} (e.g., "all caps, aggressive", "lots of emojis", "passive-aggressive").
   - "seed": A single English word (e.g., "dragon", "neon", "cat", "knight") for avatar generation.
   - "color": A HEX color fitting this character (e.g., "#ff5733").${noteBlock}

OUTPUT FORMAT:
{
    "folder_name": "Folder Name",
    "npcs": [
        { "name": "Name", "handle": "@handle", "desc": "description", "style": "style", "seed": "word", "color": "#hex" }
    ]
}`;
    },
    
    /**
     * Generate a DM reply.
     * @param {string} profileInfo — character info
     * @param {string} messageHistory — current DM conversation
     * @param {string} chatContext — context from chat
     * @param {string} userInfo — user info
     */
    generateDMReply(profileInfo, messageHistory, chatContext, userInfo, hasUserImage = false, feedContext = '', imageInstruction = '') {
        const L = rp();
        const imageRule = hasUserImage
            ? '\n9. The user attached an IMAGE — it is included in this request. React to what is ACTUALLY in the picture, casually, the way someone reacts to a photo a friend sent. Do not narrate or describe it back.'
            : '';

        // Модель и так видит присланное фото, отвечая на него — просим короткое
        // описание в том же ответе, бесплатно. Показывается кнопкой «промпт» у
        // картинки в переписке, как и у сгенерированных фото.
        const captionField = hasUserImage
            ? `,\n    "image_caption": "one SHORT sentence in ${L.NAME} describing what is actually in the photo the user sent — for the user's own reference, not shown to the character"`
            : '';

        return `You are generating a private message (DM) reply for a fictional social network simulation.
Act as the character described below and reply to the user in the DM thread.

CRITICAL: write your reply in ${L.NAME}, REGARDLESS of what language the DM HISTORY, the character profile or the context below are written in. A long history in a different language is not permission to continue in that language — ${L.NAME} is not optional.${hasUserImage ? `

THE USER JUST SENT YOU AN IMAGE — it is attached to this request and you can SEE it.
Your reply MUST be a reaction to what is actually in that picture. Do not answer as if no image arrived.` : ''}

YOUR CHARACTER PROFILE:
${profileInfo}

USER'S PROFILE (The person you are talking to):
${userInfo}

CURRENT CONTEXT (Background world/situation):
${chatContext}
${feedContext ? `
THE PUBLIC FEED RIGHT NOW (you follow this person and you HAVE seen these posts):
${feedContext}

-> Lines marked ">>> PLAYER'S POST" were posted by the person you are texting. You saw them.
-> React to them naturally when relevant: tease, agree, argue, ask about it, reference it in passing.
-> NEVER ask about something they already said in a post as if you had not seen it.
` : ''}
DM HISTORY:
${messageHistory}

CRITICAL RULES:
1. Write in ${L.NAME}. This overrides the language of everything above — the DM history, the profile, the context. Do not drift into whatever language the history happens to be in.
2. This is a CASUAL SOCIAL MEDIA DM (Direct Message), like Telegram, WhatsApp, or Twitter DMs.
3. DO NOT roleplay actions (like *smiles* or *looks away*) unless it's formatted as casual text actions. DO NOT write inner thoughts.
4. Keep it conversational, short, and natural. Use slang, typos, or emojis if it fits your character.
5. You can write ONE or MULTIPLE messages at once, depending on how your character texts (e.g. some send one long text, others spam short texts).
6. IMPORTANT: Pay attention to the CURRENT CONTEXT. Your character should react to recent roleplay events, bring them up, or ask the user (the person you're texting) about them. The user is a full participant in this story, not a passive reader.
7. YOU HAVE YOUR OWN LIFE. The RP is not all you think about. Bring up your own day unprompted — work, chores, something you saw, something that annoyed you. Sometimes you are the one starting a topic, not just answering.
8. DO NOT repeat what you already said earlier in this thread, and do not re-ask a question that was already answered. Read the history and move the conversation FORWARD.
9. You are a person with a schedule: you can be busy, distracted, tired, or in the middle of something.${imageRule}

Based on the history and the character's personality, write their NEXT response(s).

STRICT JSON FORMAT:
{
    "messages": [
        "The character's first text IN ${L.NAME}.",
        "The character's second text IN ${L.NAME} (optional)."
    ]${captionField}
}
OPTIONAL: instead of a plain string, a message may be an object { "text": "...", "transfer": { "amount": number, "currency": "USD" | "EUR" | "RUB" | "GBP" | "CNY" | "JPY", "note": "short comment IN ${L.NAME}" } } when the character is sending the user money — paying a debt back, chipping in, covering something.
CURRENCY: use the money people ACTUALLY use where this story takes place — euro in Germany or France, rouble in Russia, yen in Japan, yuan in China, pound in Britain, dollar in the US. Work it out from the RP context: the city, the country, the prices already mentioned. If the conversation has already named a currency, keep it. NEVER fall back to dollars just because they are common — a character in Berlin sending dollars is a mistake.
Use a transfer ONLY when the conversation genuinely calls for it, never at random. With a transfer, "text" may be empty.
NO MARKDOWN, NO OTHER TEXT, JUST VALID JSON.${imageInstruction}`;
    },

    /**
     * Generate a Group DM reply.
     */
    generateGroupDMReply(profilesInfo, messageHistory, chatContext, userInfo, groupName, hasUserImage = false, feedContext = '', imageInstruction = '') {
        const L = rp();
        const imageNote = hasUserImage
            ? `\n\nTHE USER JUST SENT AN IMAGE — it is attached to this request. Participants can SEE it. React to what is ACTUALLY in the picture, casually, the way a group chat reacts to a photo someone dropped. Different people notice different things. Do not narrate or describe the image back.`
            : '';
        const captionField = hasUserImage
            ? `,\n    "image_caption": "one SHORT sentence in ${L.NAME} describing what is actually in the photo the user sent — for the user's own reference, not shown to the group"`
            : '';

        return `You are generating responses for a GROUP CHAT in a fictional social network simulation.
The group is called "${groupName}".

CRITICAL: write in ${L.NAME}, REGARDLESS of what language the GROUP CHAT HISTORY, the participant profiles or the context below are written in. A long history in a different language is not permission to continue in that language — ${L.NAME} is not optional.${imageNote}

PARTICIPANTS PROFILES:
${profilesInfo}

USER'S PROFILE (The person who created the group):
${userInfo}

CURRENT CONTEXT (Background world/situation):
${chatContext}
${feedContext ? `
THE PUBLIC FEED RIGHT NOW (everyone in this group follows it and HAS seen these posts):
${feedContext}

-> Lines marked ">>> PLAYER'S POST" were posted by the user. Everyone here saw them.
-> React to them naturally when relevant: tease, agree, argue, bring it up in the group.
-> NEVER ask about something the user already said in a post as if nobody had seen it.
` : ''}
GROUP CHAT HISTORY:
${messageHistory}

CRITICAL RULES:
1. Write in ${L.NAME}. This overrides the language of everything above — the group history, the profiles, the context. Do not drift into whatever language the history happens to be in.
2. This is a CASUAL SOCIAL MEDIA GROUP CHAT (like a Telegram or WhatsApp group).
3. DO NOT roleplay actions or inner thoughts. Write only the casual text messages they would send to the group.
4. You can act as ONE OR MORE of the participants. Decide who would logically reply right now based on the conversation.
5. If multiple characters are arguing or talking, you can return multiple messages from different characters in sequence.
6. Provide the EXACT handle of the sender for each message.

Based on the history and personalities, write the next message(s) in the group chat.

STRICT JSON FORMAT:
{
    "messages": [
        { "sender_handle": "@handle_of_character_1", "text": "Message text IN ${L.NAME}" },
        { "sender_handle": "@handle_of_character_2", "text": "Another message IN ${L.NAME}" }
    ]${captionField}
}
OPTIONAL: any message may also carry "transfer": { "amount": number, "currency": "USD" | "EUR" | "RUB" | "GBP" | "CNY" | "JPY", "note": "short comment IN ${L.NAME}" } when the character is sending the user money — paying a debt back, chipping in, covering something.
CURRENCY: use the money people ACTUALLY use where this story takes place — euro in Germany or France, rouble in Russia, yen in Japan, yuan in China, pound in Britain, dollar in the US. Work it out from the RP context: the city, the country, the prices already mentioned. If the conversation has already named a currency, keep it. NEVER fall back to dollars just because they are common — a character in Berlin sending dollars is a mistake.
Use a transfer ONLY when the conversation genuinely calls for it, never at random. With a transfer, "text" may be empty.
NO MARKDOWN, NO OTHER TEXT, JUST VALID JSON.${imageInstruction}`;
    },

    /**
     * Generate a profile for a character from the chat.
     * @param {string} charName — character name
     * @param {string} charDesc — character card (description, personality, etc.)
     */
    generateCharProfile(charName, charDesc) {
        const L = rp();
        return `You are a creative AI. Your task is to create a social media profile (like Twitter) for a character from a roleplaying game.

CRITICAL: write "desc" and "style" in ${L.NAME}, REGARDLESS of what language the character card below is written in.

CHARACTER NAME: ${charName}
CHARACTER CARD:
${charDesc}

Based on this character's personality and appearance, invent for them:
1. "name": Display name for the profile (${L.nameNote}).
2. "handle": Username (must start with @, ONLY LATIN LETTERS, no spaces). Must reflect their personality.
3. "desc": A short profile "bio" (describing themselves) IN ${L.NAME}. How would this character describe themselves on a social network?
4. "style": Their posting style IN ${L.NAME} (e.g.: "all caps, aggressive", "lots of emojis", "formal, uses complex vocabulary").

OUTPUT ONLY VALID JSON.
OUTPUT FORMAT:
{
  "name": "Character Name",
  "handle": "@username",
  "desc": "Bio text",
  "style": "style description"
}`;
    },

    generateSocialMediaSummary(feedContext, dmContext, size = 'short', userName = '', previousSummary = null, whoIsWho = '') {
        const L = rp();
        if (!userName) userName = L.playerWord;
        let sizeInstruction = '';
        if (size === 'short') {
            sizeInstruction = `1. Write a SHORT summary: 1-2 sentences, no more.
2. Keep only what changes the story: who did what, and to whom. Drop atmosphere and small talk.
3. Name every participant by their REAL NAME, not by handle.`;
        } else if (size === 'medium') {
            sizeInstruction = `1. Write a summary of 3-4 sentences.
2. Cover the feed briefly, but describe the private messages (DMs) precisely: what was discussed, the tone, and any agreement reached.
3. Name every participant by their REAL NAME, not by handle.`;
        } else if (size === 'detailed') {
            sizeInstruction = `1. Write a HIGHLY DETAILED summary with DIRECT QUOTATIONS.
2. For DMs, quote the most important or emotionally charged lines verbatim, attributed to the speaker's real name.
3. Describe how the dialogue progressed, its tone, and the final outcome or agreements.
4. For feed posts, quote key phrases if they matter to the plot.
5. Use as many sentences as the events actually require.`;
        }

        const previousSummaryBlock = previousSummary
            ? `\nPREVIOUS SUMMARY (For context only):\n${previousSummary}\n\n-> IMPORTANT: The previous summary is already in the character's memory. Do NOT repeat or rewrite it. Your task is to write a NEW summary covering ONLY the NEW events below, acting as a logical continuation of the story.`
            : ``;

        // Ники в соцсети сплошь и рядом не совпадают с именами персонажей. Без этой
        // расшифровки модель принимает один и тот же персонаж за двух разных людей.
        const whoIsWhoBlock = whoIsWho
            ? `\nWHO IS WHO (handle -> real identity). The handles below are NOT names. Always resolve a handle to the real name before writing about it:\n${whoIsWho}\n`
            : ``;

        return `You are an AI assistant summarizing the recent events from a simulated social media app (NOVA/Twitter).
Your task is to provide a summary of what just happened in the social network, so the characters in the roleplay know about it.

CRITICAL: write the summary in ${L.NAME}, REGARDLESS of what language the feed posts, DMs or previous summary below are written in.${previousSummaryBlock}
${whoIsWhoBlock}
RECENT PUBLIC FEED POSTS:
${feedContext ? feedContext : "(No new posts)"}

RECENT PRIVATE MESSAGES (DMs):
${dmContext ? dmContext : "(No new private messages)"}

INSTRUCTIONS:
${sizeInstruction}
- STRICT RULE: Write in the THIRD PERSON ONLY. Do NOT use words like ${L.summaryPronouns}. Use the character's exact name or "${userName}".
- NEVER write a bare handle like "@user123" in the output. Replace every handle with the real name from WHO IS WHO. If a handle has no known name, describe the person as "${L.stranger}".
- Money transfers and attached images are real events: if one happened, say who sent what to whom.
- IMPORTANT: "${userName}" refers to a real person taking part in this roleplay. Treat the characters as aware they are interacting with an actual participant, not a background element.
- Do NOT invent events that are not in the data above.
- This is injected as a system note.
- OUTPUT ONLY THE TEXT SUMMARY IN ${L.NAME} LANGUAGE, no matter what language the source material above is in. Do not output JSON. Do not use square brackets.

Example of correct perspective (names here are placeholders): "${L.summaryExample(userName)}"`;
    }
};
