/**
 * NOVA Extension — centralized prompts for AI generation
 * All prompts are stored here for easy editing.
 */

export const NovaPrompts = {

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
     * @param {string} opts.style — активный стиль картинки, применяется автоматически,
     *   если модель не укажет свой в поле "style" тега
     * @param {boolean} opts.withReferences — приложен ли референс внешности
     */
    imageInstructionBlock({ maxImages = 0, target = 'feed', allowedHandles = '', protocol = '', style = '', withReferences = false } = {}) {
        if (!maxImages || maxImages < 1) return '';

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
  <img data-iig-instruction='{\\"prompt\\":\\"[PROMPT IN ENGLISH]\\",\\"aspect_ratio\\":\\"3:4\\",\\"image_size\\":\\"2K\\",\\"style\\":\\"\\"}' src="[IMG:GEN]">
- The JSON stays on ONE line. Single quotes around the whole object. This tag lives INSIDE a JSON string value (the object's own "text" field) — so every double quote inside it MUST be backslash-escaped (\\") exactly like the example above, or the whole response becomes invalid JSON and gets thrown away entirely. No literal newlines. Keep src="[IMG:GEN]" exactly as written.
- "aspect_ratio" accepts only: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. "image_size" accepts only: 1K, 2K, 4K. Anything else is replaced by the app's own setting.
- "style" is OPTIONAL — leave it "" to use the app's own configured visual style automatically. Only fill it in when THIS specific photo needs to look different from the usual style (e.g. a drawing, an old photograph, a screenshot).
- "prompt" is ENGLISH, one dense paragraph, no line breaks, no URLs, no file paths, no markdown. It is handed to an image generator that sees NOTHING else — not this post, not the chat, not the character cards.
- Equivalent alternative: instead of the tag, put the field "image_prompt": "..." on the object. Use ONE of the two, never both.
- The object's own "text" stays IN RUSSIAN and reads like a caption next to the photo, never a description of it.
- AT MOST ${maxImages} object${maxImages === 1 ? '' : 's'} in this whole response may carry a photo. Anything beyond that is dropped.
- No photo to send right now — no tag and no field. An empty or placeholder value is a FAILURE.
${appearance}${allowedHandles ? `
- ONLY these accounts may carry a photo: ${allowedHandles}. On anyone else it is dropped.` : ''}${protocol ? `

WHAT TO PUT IN "prompt" — the user's own rules, follow them:
${protocol}` : ''}${style ? `

CURRENT DEFAULT VISUAL STYLE (applied automatically when "style" is left empty — no need to restate it in "prompt"):
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
        const relevance = target === 'dm'
            ? `This is a private DM, so almost every message from a tracked account here already counts as a reaction to ${userHandle} — the tag should usually be present (even with "affinity_delta":0) rather than skipped. Only skip it for something that isn't really a reaction at all, like a lone sticker or a system-style notice.`
            : target === 'feed-reaction'
            ? `Every post in this batch is a reaction to ONE specific thing ${userHandle} just posted — this is not a normal feed refresh full of unrelated chatter, it IS the reactions. The tag should usually be present here too (even with "affinity_delta":0) rather than skipped.`
            : `SKIP the tag ENTIRELY when the object has nothing to do with ${userHandle} — banter with someone else, an unrelated feed post, small talk in a group chat that doesn't touch them. Most objects, even from tracked accounts, will NOT carry this tag. Putting it on everything is wrong and exactly what NOT to do.`;
        return `

RELATIONSHIP TRACKING (only for these accounts, and only when it genuinely applies): ${trackedHandles}
When an object above is written BY one of these accounts AND it is a direct reaction to ${userHandle} — a reply to something ${userHandle} said or did, a DM to them, a post clearly about them — add a hidden tag at the very END of that object's own "text" (same rule as the photo tag: removed before the post is shown, never mentioned in the visible text itself):
<span data-nova-relationship='{\\"affinity_delta\\":0,\\"status\\":\\"\\",\\"reaction\\":\\"[ONE SHORT SENTENCE, RUSSIAN]\\"}'></span>
- This tag lives INSIDE a JSON string value (the object's own "text" field) — every double quote inside it MUST be backslash-escaped (\\") exactly like the example above, or the whole response becomes invalid JSON and gets thrown away entirely.
- ${relevance}
- "affinity_delta": a NUMBER from -10 to 10, with up to ONE decimal place (0.5, -1.5, 3, -7 are all valid), how THIS exchange shifted their feelings toward ${userHandle}. 0 is a completely normal, common answer — most small talk, routine replies, or reactions that are worth a line but don't actually move the needle should get 0. Do NOT invent movement just to have a non-zero number. Use a fractional value (±0.5, ±1.5) for something that barely registers but isn't quite nothing — a small wave of your existing whole-number scale, not a separate category. Keep real whole-number swings small (±1 to ±3) too; reserve ±7 to ±10 for a genuinely major moment (betrayal, huge favor, confession).
- "status": OPTIONAL, one short phrase in RUSSIAN capturing the relationship right now — not just HOW STRONG it is, but what KIND it actually is. Romance, rivalry, family-like bonds, mentorship — whatever the story has actually built, not only degrees of friendship (e.g. "настороженная симпатия", "давние друзья", "лучшие друзья", "бро", "влюблённость", "любовники", "заклятые враги", "как старшая сестра", "обиженное молчание"). Fill it in only when it's worth being more specific than the raw number; otherwise leave it "". Unlike "reaction" below, this is a stable label for what they ARE to each other — it should persist across many exchanges, not get rewritten on every single tag. Feel free to colour the label with the actual TONE of the dynamic instead of leaving it a flat, one-word category that never changes — нежно/tender ("любовники, нежные и заботливые"), мило/wholesome ("лучшие подруги не разлей вода"), комедия/bickering ("бро, вечно подкалывают друг друга"), сухо/formal-cold ("супруги, живут будто соседи") are all fair game when that's genuinely how it plays out.
- "reaction": ONE short sentence in RUSSIAN, in the character's own voice — how they feel about ${userHandle} right now, not a summary of the scene. Can be funny, petty, warm, sarcastic — whatever actually fits the character.${newHandles ? `

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
        return `You are analyzing a roleplay to assess a relationship. The character being assessed:
${profileInfo}

FULL ROLEPLAY CONTEXT SO FAR:
${chatContext}

TASK: Based on EVERYTHING established above between this character and ${userHandle} — their history, how they actually talk to each other, any explicit relationship stated in the character card or scenario (spouse, sibling, rival, complete stranger, etc.) — assess where their relationship realistically stands RIGHT NOW. This replaces whatever number is currently stored, so be accurate rather than conservative.

Output ONLY this JSON object, nothing before or after it:
{"affinity": [integer 0-100, where 50 = neutral strangers, 80+ = established closeness or more, 20 or below = real hostility], "status": "[one short phrase in RUSSIAN naming what they ARE to each other right now — друзья, супруги, любовники, враги, etc. — or empty string if truly nothing is established yet. Colour it with the actual tone of the dynamic rather than a flat one-word category: нежно/tender, мило/wholesome, комедия/bickering, сухо/formal-cold — whichever genuinely fits, e.g. \"супруги, нежные и заботливые\" or \"бро, вечно подкалывают друг друга\"]", "reason": "[ONE short sentence in RUSSIAN explaining the estimate, in plain narration, not in character]"}`;
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
        return `

MUSIC (MoodTube is connected — a character can queue up a real track to actually play): when it genuinely fits — a character is DJing, sharing a song that matches their mood, sending a track to someone — add a hidden tag at the very END of that object's own "text" (removed before the post is shown, never mentioned in the visible text itself):
<span data-nova-music='{\\"tracks\\":[\\"Artist - Song Title\\"],\\"playlist_name\\":\\"\\",\\"note\\":\\"\\"}'></span>
- "tracks": real search queries, each as "Artist - Title" (or a clear title/mood phrase if there's no clean artist match). These are handed to an actual music player — keep them accurate and searchable, not vague or invented nonsense.
- "playlist_name": OPTIONAL, in RUSSIAN, in the character's own words (e.g. "Плейлист для тебя", "То, под что хочу с тобой засыпать") — fill this in ONLY when the character is deliberately sharing a curated PLAYLIST, not a single song. When "playlist_name" is filled in, "tracks" must have 5 to 20 real songs. When it's an ordinary one-or-a-few-song share, leave "playlist_name" "" and keep "tracks" to 1-4.
- "note": OPTIONAL, one short phrase in RUSSIAN on why this fits right now — leave "" if the visible text already makes it obvious. Skip it when "playlist_name" is filled in and the visible text already explains the playlist.
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
{"prompt": "[PROMPT IN ENGLISH]", "aspect_ratio": "3:4", "image_size": "2K", "style": ""}
Same rules as your own photos: "prompt" is English, one dense paragraph — expand the player's short description into a real prompt (setting, framing, lighting, what is actually visible). It is a photo taken by or of the PLAYER, so frame it that way. "aspect_ratio" only from: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 — pick whatever actually suits THIS photo (a selfie is usually vertical, not square). "image_size" only: 1K, 2K, 4K. "style" stays "" to use the app's configured visual style, same as for your own photos.
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
        const imageNote = hasUserImage
            ? `\nThe user attached an IMAGE to this post — it is included in this request. React to what is ACTUALLY visible in it: reply to the picture, not to a generic idea of one. Do not describe the image back; respond to it the way people reply to a photo online.`
            : '';

        // Модель и так смотрит на приложенное фото, чтобы написать реакции на него —
        // просим заодно вернуть короткое описание в том же ответе. Бесплатно: не
        // отдельный запрос, а ещё одно поле в уже идущем. Показывается той же кнопкой
        // «промпт» у картинки, что и для сгенерированных фото.
        const captionField = hasUserImage
            ? `, "image_caption": "one SHORT sentence in RUSSIAN describing what is actually in the photo — for the user's own reference, not shown to characters"`
            : '';

        const actionSection = userPostText || hasUserImage
            ? `ACTION: The user just posted: "${userPostText || '(image only, no text)'}".${imageNote}
EXCEPTION TO THE RULE: You MUST output the User's post as the FIRST item in the "posts" array exactly like this: {"author_handle": "${userHandle}", "text": "${userPostText || ''}"${captionField}}. Then, generate an active thread of REPLIES to this first post from other characters. After that, generate the rest of the feed as usual.`
            : `ACTION: Generate a fresh feed. Time has passed since the last batch — the world moved on WITHOUT waiting for the user.`;

        return `You are the core engine of the "NOVA" social media simulation (similar to X/Twitter) inside a Roleplay universe.
Your goal is to create a LIVE, IMMERSIVE, and DYNAMIC feed that reflects the ongoing story events.

CRITICAL INSTRUCTIONS:
- ALL GENERATED TEXT (posts, messages) MUST BE IN RUSSIAN LANGUAGE.
- You MUST ACTIVELY USE characters from the chat and NPCs from the list below.
- Characters from the current chat MUST be at the center of events if something important is happening in the RP.
- DO NOT generate posts or DMs on behalf of the USER / PLAYER. The user writes their own posts. Never use the User's handle in "author_handle".
- IMPORTANT: "Пользователь" (or whatever name is set in the User's profile) refers to ME — the real, active participant in this roleplay whom the characters are addressing. Treat my actions as those of a full participant in the story, not a passive observer.
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
-> NEVER write the speaker's name or handle inside "text" — the app renders the sender itself. Text starting with something like "[@someone]:" is a FAILURE.` : `-> If someone has an urgent secret reaction to the events, you may generate a "dm". Otherwise return null.`}

STRICT JSON FORMAT:
{
    "elapsed_minutes": number — how much IN-STORY time the CHAT ITSELF has moved since the previous batch. This REPORTS what the RP already shows; it does NOT give you permission to invent a time skip. If the scene is still going, it is 15-60. Only use hours or days when the chat itself clearly jumped ahead. When in doubt, use 30.
    "posts": [
        { 
            "author_handle": "@handle", 
            "text": "Post content IN RUSSIAN. Match the character's personality/style. DO NOT use hashtags unless it is deeply ingrained in the character's core personality. Do not spam tags.", 
            "likes": number, 
            "retweets": number, 
            "time": "1м", "15м", or "2ч",
            "replies": [
                {
                    "author_handle": "@reply_handle",
                    "text": "Reply text IN RUSSIAN",
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
        "text": "A private message IN RUSSIAN. Must make sense in the context of recent DMs. Or null if no DM."
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
        return `You are the core engine of the "NOVA" social media simulation inside a Roleplay universe.
Your goal is to simulate how characters would react to the User's reply.

CRITICAL INSTRUCTIONS:
- ALL GENERATED TEXT MUST BE IN RUSSIAN LANGUAGE.
- DO NOT generate posts on behalf of the USER / PLAYER (${userHandle}).
- You MUST ACTIVELY USE characters from the chat and NPCs from the list below.
- IMPORTANT: "Пользователь" (User) refers to the real person playing this roleplay. Treat their actions as those of a full participant in the story.

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
            "text": "Post content IN RUSSIAN", 
            "likes": number, 
            "retweets": number, 
            "time": "1м",
            "replies": [
                {
                    "author_handle": "@reply_handle",
                    "text": "Reply text IN RUSSIAN",
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
     */
    generateNPCFolder(chatContext) {
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

IMPORTANT: ALL GENERATED TEXT (folder name, NPC names, descriptions, styles) MUST BE IN RUSSIAN LANGUAGE (except handles and seeds).
OUTPUT ONLY VALID JSON. No conversational text. Do not use real human faces for avatars.

CURRENT RP CONTEXT:
${chatContext}

INSTRUCTIONS:
1. "folder_name": A thematic name for this group of NPCs IN RUSSIAN, directly related to the current story and characters.
2. "npcs": An array of NPC objects. Generate as many as appropriate for the context (from 3 to 10).
   - "name": Character's name (can be IN RUSSIAN OR ENGLISH). Must logically fit the country and setting.
   - "handle": Username starting with @ (STRICTLY LATIN LETTERS).
   - "desc": A short description of who they are and what they post IN RUSSIAN. For a harvested person, STATE THEIR CONNECTION explicitly — who they are to the characters and what the RP said about them (e.g. «Сестра Ло, та самая, что упоминалась в ссоре»). For an invented one, tie them to the setting.
   - "style": Their posting style IN RUSSIAN (e.g., "all caps, aggressive", "lots of emojis", "passive-aggressive").
   - "seed": A single English word (e.g., "dragon", "neon", "cat", "knight") for avatar generation.
   - "color": A HEX color fitting this character (e.g., "#ff5733").

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
        const imageRule = hasUserImage
            ? '\n9. The user attached an IMAGE — it is included in this request. React to what is ACTUALLY in the picture, casually, the way someone reacts to a photo a friend sent. Do not narrate or describe it back.'
            : '';

        // Модель и так видит присланное фото, отвечая на него — просим короткое
        // описание в том же ответе, бесплатно. Показывается кнопкой «промпт» у
        // картинки в переписке, как и у сгенерированных фото.
        const captionField = hasUserImage
            ? `,\n    "image_caption": "one SHORT sentence in RUSSIAN describing what is actually in the photo the user sent — for the user's own reference, not shown to the character"`
            : '';

        return `You are generating a private message (DM) reply for a fictional social network simulation.
Act as the character described below and reply to the user in the DM thread.${hasUserImage ? `

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

-> Lines marked ">>> ПОСТ ИГРОКА" were posted by the person you are texting. You saw them.
-> React to them naturally when relevant: tease, agree, argue, ask about it, reference it in passing.
-> NEVER ask about something they already said in a post as if you had not seen it.
` : ''}
DM HISTORY:
${messageHistory}

CRITICAL RULES:
1. This is a CASUAL SOCIAL MEDIA DM (Direct Message), like Telegram, WhatsApp, or Twitter DMs.
2. DO NOT roleplay actions (like *smiles* or *looks away*) unless it's formatted as casual text actions. DO NOT write inner thoughts.
3. Keep it conversational, short, and natural. Use slang, typos, or emojis if it fits your character.
4. You can write ONE or MULTIPLE messages at once, depending on how your character texts (e.g. some send one long text, others spam short texts).
5. IMPORTANT: Pay attention to the CURRENT CONTEXT. Your character should react to recent roleplay events, bring them up, or ask the user (the person you're texting) about them. The user is a full participant in this story, not a passive reader.
6. YOU HAVE YOUR OWN LIFE. The RP is not all you think about. Bring up your own day unprompted — work, chores, something you saw, something that annoyed you. Sometimes you are the one starting a topic, not just answering.
7. DO NOT repeat what you already said earlier in this thread, and do not re-ask a question that was already answered. Read the history and move the conversation FORWARD.
8. You are a person with a schedule: you can be busy, distracted, tired, or in the middle of something.${imageRule}

Based on the history and the character's personality, write their NEXT response(s).

STRICT JSON FORMAT:
{
    "messages": [
        "The character's first text IN RUSSIAN.",
        "The character's second text IN RUSSIAN (optional)."
    ]${captionField}
}
OPTIONAL: instead of a plain string, a message may be an object { "text": "...", "transfer": { "amount": number, "currency": "USD" | "EUR" | "RUB" | "GBP" | "CNY" | "JPY", "note": "short comment IN RUSSIAN" } } when the character is sending the user money — paying a debt back, chipping in, covering something.
CURRENCY: use the money people ACTUALLY use where this story takes place — euro in Germany or France, rouble in Russia, yen in Japan, yuan in China, pound in Britain, dollar in the US. Work it out from the RP context: the city, the country, the prices already mentioned. If the conversation has already named a currency, keep it. NEVER fall back to dollars just because they are common — a character in Berlin sending dollars is a mistake.
Use a transfer ONLY when the conversation genuinely calls for it, never at random. With a transfer, "text" may be empty.
NO MARKDOWN, NO OTHER TEXT, JUST VALID JSON.${imageInstruction}`;
    },

    /**
     * Generate a Group DM reply.
     */
    generateGroupDMReply(profilesInfo, messageHistory, chatContext, userInfo, groupName, hasUserImage = false, feedContext = '', imageInstruction = '') {
        const imageNote = hasUserImage
            ? `\n\nTHE USER JUST SENT AN IMAGE — it is attached to this request. Participants can SEE it. React to what is ACTUALLY in the picture, casually, the way a group chat reacts to a photo someone dropped. Different people notice different things. Do not narrate or describe the image back.`
            : '';
        const captionField = hasUserImage
            ? `,\n    "image_caption": "one SHORT sentence in RUSSIAN describing what is actually in the photo the user sent — for the user's own reference, not shown to the group"`
            : '';

        return `You are generating responses for a GROUP CHAT in a fictional social network simulation.
The group is called "${groupName}".${imageNote}

PARTICIPANTS PROFILES:
${profilesInfo}

USER'S PROFILE (The person who created the group):
${userInfo}

CURRENT CONTEXT (Background world/situation):
${chatContext}
${feedContext ? `
THE PUBLIC FEED RIGHT NOW (everyone in this group follows it and HAS seen these posts):
${feedContext}

-> Lines marked ">>> ПОСТ ИГРОКА" were posted by the user. Everyone here saw them.
-> React to them naturally when relevant: tease, agree, argue, bring it up in the group.
-> NEVER ask about something the user already said in a post as if nobody had seen it.
` : ''}
GROUP CHAT HISTORY:
${messageHistory}

CRITICAL RULES:
1. This is a CASUAL SOCIAL MEDIA GROUP CHAT (like a Telegram or WhatsApp group).
2. DO NOT roleplay actions or inner thoughts. Write only the casual text messages they would send to the group.
3. You can act as ONE OR MORE of the participants. Decide who would logically reply right now based on the conversation.
4. If multiple characters are arguing or talking, you can return multiple messages from different characters in sequence.
5. Provide the EXACT handle of the sender for each message.

Based on the history and personalities, write the next message(s) in the group chat.

STRICT JSON FORMAT:
{
    "messages": [
        { "sender_handle": "@handle_of_character_1", "text": "Message text IN RUSSIAN" },
        { "sender_handle": "@handle_of_character_2", "text": "Another message IN RUSSIAN" }
    ]${captionField}
}
OPTIONAL: any message may also carry "transfer": { "amount": number, "currency": "USD" | "EUR" | "RUB" | "GBP" | "CNY" | "JPY", "note": "short comment IN RUSSIAN" } when the character is sending the user money — paying a debt back, chipping in, covering something.
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
        return `You are a creative AI. Your task is to create a social media profile (like Twitter) for a character from a roleplaying game.
        
CHARACTER NAME: ${charName}
CHARACTER CARD:
${charDesc}

Based on this character's personality and appearance, invent for them:
1. "name": Display name for the profile (can be in Russian or English).
2. "handle": Username (must start with @, ONLY LATIN LETTERS, no spaces). Must reflect their personality.
3. "desc": A short profile "bio" (describing themselves) IN RUSSIAN. How would this character describe themselves on a social network?
4. "style": Their posting style IN RUSSIAN (e.g.: "all caps, aggressive", "lots of emojis", "formal, uses complex vocabulary").

OUTPUT ONLY VALID JSON.
OUTPUT FORMAT:
{
  "name": "Character Name",
  "handle": "@username",
  "desc": "Bio text",
  "style": "style description"
}`;
    },

    generateSocialMediaSummary(feedContext, dmContext, size = 'short', userName = 'Игрок', previousSummary = null, whoIsWho = '') {
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
Your task is to provide a summary of what just happened in the social network, so the characters in the roleplay know about it.${previousSummaryBlock}
${whoIsWhoBlock}
RECENT PUBLIC FEED POSTS:
${feedContext ? feedContext : "(No new posts)"}

RECENT PRIVATE MESSAGES (DMs):
${dmContext ? dmContext : "(No new private messages)"}

INSTRUCTIONS:
${sizeInstruction}
- STRICT RULE: Write in the THIRD PERSON ONLY. Do NOT use words like "you", "your", "I", "my", "вы", "вам", "ты", "мне". Use the character's exact name or "${userName}".
- NEVER write a bare handle like "@user123" in the output. Replace every handle with the real name from WHO IS WHO. If a handle has no known name, describe the person as "незнакомец из соцсети".
- Money transfers and attached images are real events: if one happened, say who sent what to whom.
- IMPORTANT: "${userName}" refers to a real person taking part in this roleplay. Treat the characters as aware they are interacting with an actual participant, not a background element.
- Do NOT invent events that are not in the data above.
- This is injected as a system note.
- OUTPUT ONLY THE TEXT SUMMARY IN RUSSIAN LANGUAGE. Do not output JSON. Do not use square brackets.

Example of correct perspective (names here are placeholders): "В соцсети Кенто опубликовал новое фото. В личных сообщениях Юки написала ${userName}, предложив встретиться, и ${userName} согласился."`;
    }
};
