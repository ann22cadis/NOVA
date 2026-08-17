import { generateRaw } from '../../../../script.js';
import { NovaPrompts } from './prompts.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';
import { saveBase64AsFile } from '../../../utils.js';
// Живой биндинг: значение всегда актуальное, а не снимок на момент импорта.
// Не приходит через getContext() — эта функция там его просто не отдаёт
import { user_avatar as livePersonaAvatarId } from '../../../personas.js';

(async function() {
    console.log("[NOVA] Loading extension...");

    // Имя папки берём из URL самого модуля, а не хардкодим: после переименования Link → NOVA
    // расширение должно грузить style.css и шаблоны из той папки, где реально лежит.
    const EXTENSION_PATH = (() => {
        const m = /\/scripts\/extensions\/(.+)\/index\.js/.exec(import.meta.url);
        return m ? m[1] : 'third-party/NOVA';
    })();
    const TEMPLATES_PATH = `${EXTENSION_PATH}/templates`;

    let feedPosts = [];
    let dmThreads = [];
    // Какому чату реально принадлежит то, что сейчас в feedPosts/dmThreads — не
    // обязательно текущему: chat_id_changed мог не долететь, а loadFeed() зовётся
    // только при открытии панели. saveFeed() сверяется с этим перед записью —
    // см. её же комментарий про защиту от затирания.
    let loadedFeedChatId = null;
    // Виртуальные минуты ролевой игры. Реальное время тут не годится: между генерациями
    // в РП может пройти три дня, а по часам — пять минут.
    let rpClock = 0;
    let customFolders = [];
    
    let feedSelectMode = false;
    let selectedFeedPosts = new Set();

    // Тот же выбор вручную, что у постов ленты, но для ответов внутри открытого
    // треда — ключ это путь ответа (currentPath.join(',')), уникальный внутри
    // ОДНОГО открытого поста, а не глобально
    let replySelectMode = false;
    let selectedReplyKeys = new Set();
    let currentSinglePostIndex = null;

    let novaSummarySize = 'short';
    
    /**
     * Ввод одной строки в стиле панели. Родной prompt() в мобильной Таверне
     * выглядит инородно и на некоторых оболочках блокируется.
     * @returns {Promise<string|null>} null — если отменили
     */
    // Валюты для переводов. Символ идёт в карточку, код — в промпт модели.
    // Юань пишем как 元, иначе он неотличим от иены: обе валюты используют ¥.
    const NOVA_CURRENCIES = [
        { code: 'USD', symbol: '$', label: 'Доллар' },
        { code: 'EUR', symbol: '€', label: 'Евро' },
        { code: 'RUB', symbol: '₽', label: 'Рубль' },
        { code: 'GBP', symbol: '£', label: 'Фунт' },
        { code: 'CNY', symbol: '元', label: 'Юань' },
        { code: 'JPY', symbol: '¥', label: 'Иена' },
    ];
    // Валюта, предвыбранная в диалоге перевода у пользователя. К персонажам отношения не имеет:
    // они берут валюту из сеттинга, и она приезжает в поле currency вместе с переводом.
    const DEFAULT_CURRENCY = 'USD';

    /**
     * Свой выпадающий список вместо <select>: нативный на телефоне открывается
     * системным пикером и выпадает из оформления расширения.
     */
    function buildCustomSelect(id, options, selectedValue) {
        const selected = options.find(o => o.value === selectedValue) || options[0];
        const items = options.map(o => `
            <div class="nova-select-option${o.value === selected?.value ? ' selected' : ''}" data-value="${o.value}">
                <span>${o.label}</span>
                <i class="fa-solid fa-check"></i>
            </div>`).join('');

        return `
            <div class="nova-select" id="${id}" data-value="${selected?.value ?? ''}">
                <button type="button" class="nova-select-trigger">
                    <span class="nova-select-label">${selected?.label ?? ''}</span>
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <div class="nova-select-menu">${items}</div>
            </div>`;
    }

    // Одно делегирование на все кастомные списки внутри контейнера
    function wireCustomSelects($root) {
        $root.on('click', '.nova-select-trigger', function (e) {
            e.stopPropagation();
            const $select = $(this).closest('.nova-select');
            const wasOpen = $select.hasClass('open');
            $root.find('.nova-select').removeClass('open');
            $select.toggleClass('open', !wasOpen);
        });

        $root.on('click', '.nova-select-option', function (e) {
            // БЕЗ stopPropagation: некоторые списки (пресет/стиль/профиль картинок)
            // ещё и делегированы отдельно на document — те обработчики переключают
            // cfg.active_* и зовут renderImageSettings(), а не только красят лейбл.
            // stopPropagation тут глушил их полностью: список визуально открывался
            // и галочка переставлялась, но активный пресет/стиль на самом деле не
            // менялся — а сохранение потом улетало не в тот объект.
            const $option = $(this);
            const $select = $option.closest('.nova-select');
            $select.attr('data-value', $option.data('value'));
            $select.find('.nova-select-label').text($option.find('span').text());
            $select.find('.nova-select-option').removeClass('selected');
            $option.addClass('selected');
            $select.removeClass('open');
        });

        // Клик мимо — закрыть открытый список, но не сам диалог
        $root.on('click', function (e) {
            if (!$(e.target).closest('.nova-select').length) $root.find('.nova-select').removeClass('open');
        });
    }

    /**
     * Диалог перевода: сумма, валюта, комментарий и — в беседе — получатель.
     * @returns {Promise<{amount:number,currency:string,note:string,to:string}|null>}
     */
    function novaTransferDialog(recipients = []) {
        return new Promise(resolve => {
            const currencySelect = buildCustomSelect(
                'nova-transfer-currency',
                NOVA_CURRENCIES.map(c => ({ value: c.code, label: `${c.symbol} ${c.label}` })),
                DEFAULT_CURRENCY,
            );
            const recipientBlock = recipients.length > 1 ? `
                <div style="margin-bottom: 14px;">
                    <div style="color: var(--nova-text-muted); font-size: 13px; margin-bottom: 6px;">Кому</div>
                    ${buildCustomSelect('nova-transfer-to', recipients.map(r => ({ value: r.handle, label: r.name })), recipients[0]?.handle)}
                </div>` : '';

            const html = `
                <div id="nova-transfer-overlay" class="nova-folder-overlay active" style="z-index: 9999; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.6);">
                    <div style="background: var(--nova-surface); border: 1px solid var(--nova-border); border-radius: 16px; padding: 24px; max-width: 340px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                        <div style="font-weight: bold; font-size: 18px; margin-bottom: 18px; color: var(--nova-text);">Перевод</div>
                        ${recipientBlock}
                        <div style="display: flex; gap: 10px; margin-bottom: 14px;">
                            <div style="flex: 2; min-width: 0;">
                                <div style="color: var(--nova-text-muted); font-size: 13px; margin-bottom: 6px;">Сумма</div>
                                <input id="nova-transfer-amount" type="number" min="1" step="1" placeholder="0" class="nova-transfer-field">
                            </div>
                            <div style="flex: 1.4; min-width: 0;">
                                <div style="color: var(--nova-text-muted); font-size: 13px; margin-bottom: 6px;">Валюта</div>
                                ${currencySelect}
                            </div>
                        </div>
                        <div style="margin-bottom: 20px;">
                            <div style="color: var(--nova-text-muted); font-size: 13px; margin-bottom: 6px;">Комментарий</div>
                            <input id="nova-transfer-note" type="text" placeholder="необязательно" class="nova-transfer-field">
                        </div>
                        <div style="display: flex; gap: 12px;">
                            <button id="nova-transfer-cancel" style="flex: 1; background: var(--nova-surface-hover); color: var(--nova-text); border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold;">Отмена</button>
                            <button id="nova-transfer-ok" style="flex: 1; background: var(--nova-accent); color: white; border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold;">Отправить</button>
                        </div>
                    </div>
                </div>
            `;
            $('#nova-backdrop').append(html);
            const $overlay = $('#nova-transfer-overlay');
            const $amount = $('#nova-transfer-amount');
            wireCustomSelects($overlay);
            setTimeout(() => $amount.focus(), 50);

            const close = value => { $overlay.remove(); resolve(value); };
            const submit = () => {
                const amount = Math.round(Number(String($amount.val()).replace(',', '.')));
                if (!Number.isFinite(amount) || amount <= 0) {
                    toastr.warning('Введите сумму больше нуля.');
                    return;
                }
                close({
                    amount,
                    currency: String($('#nova-transfer-currency').attr('data-value') || DEFAULT_CURRENCY),
                    note: String($('#nova-transfer-note').val() || '').trim(),
                    to: String($('#nova-transfer-to').attr('data-value') || ''),
                });
            };

            $('#nova-transfer-cancel').on('click', () => close(null));
            $('#nova-transfer-ok').on('click', submit);
            $overlay.on('keydown', e => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') close(null);
            });
            $overlay.on('click', e => { if (e.target === $overlay[0]) close(null); });
        });
    }

    function novaPrompt(title, placeholder = '', type = 'text') {
        return new Promise(resolve => {
            const html = `
                <div id="nova-prompt-overlay" class="nova-folder-overlay active" style="z-index: 9999; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.6);">
                    <div style="background: var(--nova-surface); border: 1px solid var(--nova-border); border-radius: 16px; padding: 24px; max-width: 320px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                        <div style="font-weight: bold; font-size: 18px; margin-bottom: 16px; color: var(--nova-text);">${title}</div>
                        <input id="nova-prompt-input" type="${type}" placeholder="${placeholder}" style="width: 100%; box-sizing: border-box; background: var(--nova-surface-hover); border: 1px solid var(--nova-border); color: var(--nova-text); padding: 12px 14px; border-radius: 10px; outline: none; font-size: 15px; font-family: inherit; margin-bottom: 20px;">
                        <div style="display: flex; gap: 12px;">
                            <button id="nova-prompt-cancel" style="flex: 1; background: var(--nova-surface-hover); color: var(--nova-text); border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold;">Отмена</button>
                            <button id="nova-prompt-ok" style="flex: 1; background: var(--nova-accent); color: white; border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold;">Готово</button>
                        </div>
                    </div>
                </div>
            `;
            $('#nova-backdrop').append(html);
            const $overlay = $('#nova-prompt-overlay');
            const $input = $('#nova-prompt-input');
            setTimeout(() => $input.focus(), 50);

            const close = value => { $overlay.remove(); resolve(value); };
            $('#nova-prompt-cancel').on('click', () => close(null));
            $('#nova-prompt-ok').on('click', () => close($input.val()));
            $input.on('keydown', e => {
                if (e.key === 'Enter') close($input.val());
                if (e.key === 'Escape') close(null);
            });
            $overlay.on('click', e => { if (e.target === $overlay[0]) close(null); });
        });
    }

    function novaConfirm(message, onConfirm, okLabel = 'Удалить', okColor = '#f44336') {
        const html = `
            <div id="nova-confirm-overlay" class="nova-folder-overlay active" style="z-index: 9999; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.6);">
                <div style="background: var(--nova-dm-card, var(--nova-surface)); border: 1px solid var(--nova-dm-border, var(--nova-border)); border-radius: 16px; padding: 24px; max-width: 320px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                    <div style="font-weight: bold; font-size: 18px; margin-bottom: 12px; color: var(--nova-dm-card-text, var(--nova-text));">Подтверждение</div>
                    <div style="color: var(--nova-dm-card-text, var(--nova-text-muted)); opacity: 0.85; font-size: 15px; margin-bottom: 24px; line-height: 1.4;">${message}</div>
                    <div style="display: flex; justify-content: center; gap: 12px; margin-top: 10px;">
                        <button id="nova-confirm-cancel" style="flex: 1; background: var(--nova-dm-other-bubble, var(--nova-surface-hover)); color: var(--nova-dm-card-text, var(--nova-text)); border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold; transition: 0.2s;">Отмена</button>
                        <button id="nova-confirm-ok" style="flex: 1; background: ${okColor}; color: white; border: none; cursor: pointer; padding: 10px 16px; border-radius: 8px; font-size: 14px; font-weight: bold; transition: 0.2s;">${escapeHtml(okLabel)}</button>
                    </div>
                </div>
            </div>
        `;
        $('#nova-backdrop').append(html);

        $('#nova-confirm-cancel').off('click').on('click', () => {
            $('#nova-confirm-overlay').remove();
        });

        $('#nova-confirm-ok').off('click').on('click', () => {
            $('#nova-confirm-overlay').remove();
            if (onConfirm) onConfirm();
        });
    }

    /**
     * До переименования расширение хранило всё под ключом Link. Переносим блок целиком
     * один раз, иначе у старых пользователей пропадут папки, профили и ленты чатов.
     */
    function migrateLegacySettings() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext?.extensionSettings) return;
        const legacy = stContext.extensionSettings.Link;
        if (!legacy || stContext.extensionSettings.NOVA) return;

        stContext.extensionSettings.NOVA = legacy;
        delete stContext.extensionSettings.Link;
        stContext.saveSettingsDebounced();
        console.log('[NOVA] Настройки перенесены со старого ключа Link.');
    }

    function loadFolders() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stContext && stContext.extensionSettings?.NOVA?.customFolders) {
            customFolders = stContext.extensionSettings.NOVA.customFolders;
            // Раньше папка держала ОДИН chatId — активация в новом чате перепривязывала
            // папку туда и молча выкидывала из старого. Переносим на список chatIds:
            // папка теперь активна в КАЖДОМ чате, где её когда-либо активировали, разом
            customFolders.forEach(f => {
                if (Array.isArray(f.chatIds)) return; // уже мигрировано
                if (typeof f.chatId === 'string' && f.chatId) {
                    // 'archive_...' — старый хак для «убрать из архива вручную»: папка
                    // не привязана ни к одному чату
                    f.chatIds = f.chatId.startsWith('archive_') ? [] : [f.chatId];
                } else {
                    f.chatIds = null; // никогда не была привязана — видна везде, как раньше
                }
            });
        }
        if (stContext && stContext.extensionSettings?.NOVA?.defaultFolderState) {
            const state = stContext.extensionSettings.NOVA.defaultFolderState;
            if (state.active !== undefined) defaultFolder.active = state.active;

            if (Array.isArray(state.npcsData)) {
                // Новый формат: папка Default редактируется целиком
                defaultFolder.npcs = state.npcsData;
            } else if (state.npcs) {
                // Старый формат: сохранялись только флаги активности
                defaultFolder.npcs.forEach(npc => {
                    if (state.npcs[npc.id] !== undefined) {
                        npc.active = state.npcs[npc.id];
                    }
                });
            }
        }
    }

    function loadSettings() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stContext && stContext.extensionSettings?.NOVA) {
            if (stContext.extensionSettings.NOVA.summarySize !== undefined) {
                novaSummarySize = stContext.extensionSettings.NOVA.summarySize;
            }
            if (stContext.extensionSettings.NOVA.disabledGroupChars) {
                disabledGroupChars = new Set(stContext.extensionSettings.NOVA.disabledGroupChars.map(String));
            }
        }
    }
    
    function saveFolders() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stContext) {
            if (!stContext.extensionSettings.NOVA) stContext.extensionSettings.NOVA = {};
            stContext.extensionSettings.NOVA.customFolders = customFolders;
            stContext.extensionSettings.NOVA.summarySize = novaSummarySize;
            stContext.extensionSettings.NOVA.disabledGroupChars = Array.from(disabledGroupChars);
            
            stContext.extensionSettings.NOVA.defaultFolderState = {
                active: defaultFolder.active,
                npcsData: defaultFolder.npcs,
                npcs: {}
            };
            // Дублируем флаги активности для совместимости со старыми версиями
            defaultFolder.npcs.forEach(npc => {
                stContext.extensionSettings.NOVA.defaultFolderState.npcs[npc.id] = npc.active;
            });

            stContext.saveSettingsDebounced();
        }
    }

    /**
     * Снимок ленты чата ДО того, как мы к ней прикоснёмся — на случай, если что-то
     * в этой сессии её сломает. По снимку на каждое реальное изменение (сверяем по
     * числу постов/переписок — дёшево и достаточно, чтобы не плодить дубликаты при
     * частых переключениях туда-сюда без правок), максимум 5 штук на чат.
     */
    function backupChatFeedIfNeeded(chatId, entry) {
        if (!entry) return;
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return;
        if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};
        const store = ctx.extensionSettings.NOVA;
        if (!store.chatFeedBackups || typeof store.chatFeedBackups !== 'object') store.chatFeedBackups = {};
        const list = store.chatFeedBackups[chatId] || (store.chatFeedBackups[chatId] = []);
        const postsCount = (entry.feedPosts || []).length;
        const threadsCount = (entry.dmThreads || []).length;
        const last = list[list.length - 1];
        if (last && last.postsCount === postsCount && last.threadsCount === threadsCount) return;
        list.push({ time: Date.now(), postsCount, threadsCount, data: structuredClone(entry) });
        while (list.length > 5) list.shift();
    }

    function loadFeed() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stContext) {
            const chatId = getCurrentChatId();
            const entry = stContext.extensionSettings?.NOVA?.chatFeeds?.[chatId];
            backupChatFeedIfNeeded(chatId, entry);
            if (entry) {
                feedPosts = entry.feedPosts || [];
                dmThreads = entry.dmThreads || [];
                rpClock = Number(entry.rpClock) || 0;
                if (dmThreads.length > 0 && dmThreads[0].text !== undefined) {
                    dmThreads = []; // Сброс старого формата DMs
                }
            } else {
                feedPosts = [];
                dmThreads = [];
                rpClock = 0;
            }
            loadedFeedChatId = chatId;
        } else {
            feedPosts = [];
            dmThreads = [];
            loadedFeedChatId = null;
        }
        applyLatestProfileInfoToPosts();
    }

    /**
     * Карты «по хэндлу» и «по имени» для сопоставления поста с живым профилем.
     * Вынесено отдельно, потому что этим пользуются ДВЕ стороны одной медали:
     * applyLatestProfileInfoToPosts (подставляет аватарку при загрузке) и
     * slimPostForStorage (убирает её при сохранении). Разъедься их логика —
     * аватарка перестанет восстанавливаться после перезапуска.
     */
    function buildProfileLookup() {
        const activeProfiles = typeof getActiveProfiles === 'function' ? getActiveProfiles() : [];
        const handleMap = {};
        const nameMap = {};
        activeProfiles.forEach(ap => {
            if (ap.handle) handleMap[ap.handle.toLowerCase()] = ap;
            if (ap.name) nameMap[ap.name.toLowerCase()] = ap;
        });
        return { activeProfiles, handleMap, nameMap };
    }

    /** Профиль для поста/ответа/треда: хэндл точнее имени, поэтому проверяется вторым. */
    function matchProfileFor(item, lookup) {
        let matched = lookup.nameMap[String(item?.name || '').toLowerCase()];
        const byHandle = lookup.handleMap[String(item?.handle || '').toLowerCase()];
        if (byHandle) matched = byHandle;
        return matched;
    }

    function applyLatestProfileInfoToPosts() {
        const lookup = buildProfileLookup();
        const { activeProfiles, handleMap, nameMap } = lookup;
        if (!activeProfiles.length || (!feedPosts.length && !dmThreads.length)) return;

        let changed = false;

        const patchReplies = (replies) => {
            if (!replies) return;
            replies.forEach(reply => {
                if (!reply || typeof reply !== 'object') return;
                const currentH = (reply.handle || '').toLowerCase();
                const currentN = (reply.name || '').toLowerCase();
                let matchedProfile = nameMap[currentN];
                if (handleMap[currentH]) matchedProfile = handleMap[currentH];

                // Починка старых записей: у вложенных ответов профиль мог вообще не проставиться
                if (!reply.handle || !reply.name) {
                    const resolved = resolveAuthorProfile(reply.author_handle ?? reply.authorHandle ?? reply.handle, activeProfiles, reply.name);
                    reply.handle = resolved.handle;
                    reply.name = resolved.name;
                    reply.avatar = resolved.avatar || '';
                    reply.color = resolved.color || reply.color || '#333';
                    if (!Array.isArray(reply.replies)) reply.replies = [];
                    changed = true;
                } else if (matchedProfile) {
                    // Аватарка — производная от профиля, в настройках её нет (см. saveFeed).
                    // Подставляем всегда и НЕ помечаем changed: иначе каждая загрузка ленты
                    // тут же дёргала бы сохранение просто потому, что её пришлось восстановить.
                    if (matchedProfile.avatar) reply.avatar = matchedProfile.avatar;
                    if (reply.handle !== matchedProfile.handle || reply.name !== matchedProfile.name) {
                        reply.handle = matchedProfile.handle;
                        reply.name = matchedProfile.name;
                        changed = true;
                    }
                }
                if (reply.replies) patchReplies(reply.replies);
            });
        };

        feedPosts.forEach(post => {
            const currentH = (post.handle || '').toLowerCase();
            const currentN = (post.name || '').toLowerCase();
            let matchedProfile = nameMap[currentN];
            if (handleMap[currentH]) matchedProfile = handleMap[currentH];

            if (matchedProfile) {
                // См. комментарий у ответов выше — аватарка восстанавливается молча
                if (matchedProfile.avatar) post.avatar = matchedProfile.avatar;
                if (post.handle !== matchedProfile.handle || post.name !== matchedProfile.name) {
                    post.handle = matchedProfile.handle;
                    post.name = matchedProfile.name;
                    changed = true;
                }
            }
            patchReplies(post.replies);
        });

        dmThreads.forEach(thread => {
            if (thread.isGroup) return;
            const currentH = (thread.handle || '').toLowerCase();
            const currentN = (thread.name || '').toLowerCase();
            let matchedProfile = nameMap[currentN];
            if (handleMap[currentH]) matchedProfile = handleMap[currentH];

            if (matchedProfile) {
                // См. комментарий у ответов выше — аватарка восстанавливается молча
                if (matchedProfile.avatar) thread.avatar = matchedProfile.avatar;
                if (thread.handle !== matchedProfile.handle || thread.name !== matchedProfile.name) {
                    thread.handle = matchedProfile.handle;
                    thread.name = matchedProfile.name;
                    changed = true;
                }
            }
        });

        if (changed) {
            saveFeed();
        }
    }

    /**
     * Копия поста/ответа/треда без аватарки — но только если её потом реально
     * можно восстановить по профилю (та же самая строка лежит в нём).
     *
     * Аватарка в посте — это КОПИЯ аватарки профиля, а не собственные данные поста,
     * и копия эта дублировалась в каждый пост и каждый ответ. На реальных данных это
     * 3.19 МБ из 3.29 МБ всей ленты: 82 копии двух картинок, уникального — 170 КБ.
     * А поскольку Таверна сохраняет НЕ нашу ветку, а весь settings.json целиком, этот
     * объём пересериализовывался и уезжал на сервер на КАЖДЫЙ saveFeed (то есть на
     * каждое сообщение, реакцию и удаление).
     *
     * Аватарку постов удалённых персонажей (профиля больше нет — сопоставить не с чем)
     * оставляем как есть: восстанавливать её будет неоткуда. Обратно живые подставляет
     * applyLatestProfileInfoToPosts при загрузке.
     */
    function slimForStorage(item, lookup) {
        if (!item || typeof item !== 'object') return item;
        const matched = matchProfileFor(item, lookup);
        const copy = { ...item };
        if (item.avatar && matched?.avatar === item.avatar) delete copy.avatar;
        if (Array.isArray(item.replies)) copy.replies = item.replies.map(r => slimForStorage(r, lookup));
        return copy;
    }

    function saveFeed() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stContext) {
            const chatId = getCurrentChatId();
            if (!stContext.extensionSettings.NOVA) stContext.extensionSettings.NOVA = {};
            if (!stContext.extensionSettings.NOVA.chatFeeds) stContext.extensionSettings.NOVA.chatFeeds = {};
            // Защита от затирания: feedPosts/dmThreads в памяти могли остаться от
            // ПРЕЖНЕГО чата, если он сменился без loadFeed() следом (событие смены
            // чата не долетело, гонка при быстром переключении). Пишем под тот чат,
            // которому эти данные реально принадлежат — иначе можно затереть чужую,
            // настоящую ленту пустотой или чужой историей. chat_id_changed ниже это
            // держит в норме почти всегда, тут — подстраховка на случай, если нет.
            const targetChatId = loadedFeedChatId || chatId;
            if (targetChatId !== chatId) {
                console.warn('[NOVA] saveFeed(): в памяти данные другого чата — сохраняю под ним, а не под текущим', { loadedFeedChatId, chatId });
            }
            // Храним КОПИИ, а не сами массивы: тут из них вырезаются аватарки, а живые
            // объекты в памяти должны остаться нетронутыми — на них смотрит весь рендер.
            const lookup = buildProfileLookup();
            stContext.extensionSettings.NOVA.chatFeeds[targetChatId] = {
                feedPosts: feedPosts.map(p => slimForStorage(p, lookup)),
                dmThreads: dmThreads.map(t => slimForStorage(t, lookup)),
                rpClock: rpClock
            };
            stContext.saveSettingsDebounced();
        }
    }

    function syncProfilePosts(oldHandle, newProfile) {
        if (!oldHandle || !newProfile || !newProfile.handle) return;
        const oldH = oldHandle.toLowerCase();
        let changed = false;

        const syncReplies = (replies) => {
            if (!replies) return;
            replies.forEach(reply => {
                if ((reply.handle || '').toLowerCase() === oldH) {
                    reply.handle = newProfile.handle;
                    if (newProfile.name) reply.name = newProfile.name;
                    if (newProfile.avatar) reply.avatar = newProfile.avatar;
                    changed = true;
                }
                if (reply.replies) syncReplies(reply.replies);
            });
        };

        feedPosts.forEach(post => {
            if ((post.handle || '').toLowerCase() === oldH) {
                post.handle = newProfile.handle;
                if (newProfile.name) post.name = newProfile.name;
                if (newProfile.avatar) post.avatar = newProfile.avatar;
                changed = true;
            }
            syncReplies(post.replies);
        });

        dmThreads.forEach(thread => {
            if ((thread.handle || '').toLowerCase() === oldH && !thread.isGroup) {
                thread.handle = newProfile.handle;
                if (newProfile.name) thread.name = newProfile.name;
                if (newProfile.avatar) thread.avatar = newProfile.avatar;
                changed = true;
            }
        });

        if (changed) {
            saveFeed();
            renderFeed();
        }
    }

    // Отключённые персонажи в групповых чатах (по avatar/id)
    let disabledGroupChars = new Set();

    // Две независимые метки прогресса. Пересказ и дословная вставка — разные
    // способы донести события до ролеплея, и считать прочитанное они обязаны
    // порознь: иначе саммари «съедает» то, что ещё не вставлено, и наоборот.
    const MARK_SUMMARY = 'isLastSummarized';   // зелёная полоска
    const MARK_INSERT = 'isLastInserted';      // голубая полоска

    /**
     * Виды скрытых блоков, которые расширение кладёт в сообщения чата.
     * Пересказ и дословная вставка — разные сущности, поэтому у них разные
     * подписи в тексте блока, разный цвет полоски и разные карточки в «Памяти».
     */
    const CONTEXT_KINDS = {
        summary: {
            mark: MARK_SUMMARY,
            label: 'События в соцсети',   // подпись внутри блока, уезжает модели
            title: 'Пересказ',            // как называется в интерфейсе
            color: '#4caf50',
            markerText: 'Пересказано в чат',
        },
        transcript: {
            mark: MARK_INSERT,
            label: 'Переписка в соцсети',
            title: 'Переписка',
            color: '#1da1f2',
            markerText: 'Вставлено в чат',
        },
    };

    // 💭 События — подпись из старых версий расширения, читаем ради совместимости.
    // Группа 1 — вид блока, группа 2 — сам текст.
    const CONTEXT_LABELS = '💭 События|События в соцсети|Переписка в соцсети';
    /** Новый экземпляр: у глобальной регулярки живёт lastIndex и её нельзя переиспользовать. */
    function contextMarkerRegex(trailing = false) {
        return new RegExp(
            `<span class="nova-hidden-context"[^>]*>\\[(${CONTEXT_LABELS}): ([\\s\\S]*?)\\]<\\/span>${trailing ? '\\s*' : ''}`,
            'g'
        );
    }

    /** По подписи из блока — какой это вид. Неизвестное считаем пересказом: так было раньше. */
    function contextKindByLabel(label) {
        return label === CONTEXT_KINDS.transcript.label ? 'transcript' : 'summary';
    }

    /**
     * Полоски «докуда уже ушло в чат» под постом или сообщением. Обе метки
     * независимы, поэтому на одном элементе их может оказаться сразу две —
     * например, пересказ дошёл до сюда же, докуда и дословная вставка.
     */
    function renderContextMarkers(item) {
        if (!item) return '';
        return Object.values(CONTEXT_KINDS)
            .filter(kind => item[kind.mark])
            .map(kind => `<div class="nova-context-marker" style="--nova-marker-color: ${kind.color};"><span>${kind.markerText}</span></div>`)
            .join('');
    }

    /**
     * Что накопилось в NOVA с прошлой выгрузки в чат конкретным способом.
     * @param {string} mark MARK_SUMMARY или MARK_INSERT
     * @returns {{posts: Array, threads: Array<{thread: Object, messages: Array}>}}
     */
    function collectUnsyncedEvents(mark = MARK_SUMMARY) {
        let posts = [];
        if (feedPosts && feedPosts.length > 0) {
            // feedPosts хранится новыми вперёд: всё, что лежит ДО метки, ещё не выгружено
            const lastIdx = feedPosts.findIndex(p => p[mark]);
            posts = lastIdx !== -1 ? feedPosts.slice(0, lastIdx) : feedPosts.slice(0, 15);
        }

        const threads = [];
        (dmThreads || []).forEach(t => {
            if (!t?.messages?.length) return;
            let lastIdx = -1;
            for (let i = t.messages.length - 1; i >= 0; i--) {
                if (t.messages[i][mark]) { lastIdx = i; break; }
            }
            const messages = lastIdx !== -1 ? t.messages.slice(lastIdx + 1) : t.messages.slice(-15);
            if (messages.length) threads.push({ thread: t, messages });
        });

        return { posts, threads };
    }

    /**
     * Разворачивает события в текст. Возвращает три куска отдельно, потому что
     * пересказу они уходят как разные секции промпта, а дословной вставке — подряд.
     *
     * Легенда обязательна в обоих режимах: ники в соцсети сплошь и рядом не совпадают
     * с именами персонажей («@nanami_apologist» → Нанами Кенто), и без расшифровки
     * модель ролеплея видит просто набор строк и путает, кто с кем говорил.
     * @returns {{legend: string, feed: string, dms: string}}
     */
    function describeEvents(events) {
        const profiles = getActiveProfiles();
        const userProfile = profiles.find(p => p.isUser) || { name: 'Игрок', handle: '@user', isUser: true };

        const seen = [];
        const fallbackNames = {};
        const remember = (handle, name) => {
            const key = normHandle(handle);
            if (!key) return;
            if (!seen.includes(key)) seen.push(key);
            if (name && !fallbackNames[key]) fallbackNames[key] = String(name);
        };
        // Имя для выгрузки берём таверновское (chatName), а не то, что выставлено
        // в профиле соцсети: ролеплей знает персонажа под именем из карточки,
        // и расшифровка ника обязана указывать именно на него
        const realName = (key, fallback) => {
            const profile = profiles.find(p => normHandle(p.handle) === key);
            return profile?.chatName || profile?.name || fallback || fallbackNames[key];
        };
        const label = (handle, name) => {
            const key = normHandle(handle);
            const shown = realName(key, name);
            // Имени нет вообще — не дублируем ник сам в себя видом «@gojo (@gojo)»
            return shown ? `${shown} (@${key})` : `@${key}`;
        };
        const flat = text => String(text || '').replace(/\s+/g, ' ').trim();

        // --- Лента ---
        const feedLines = [];
        const pushReplies = (replies, depth) => {
            (replies || []).forEach(r => {
                if (!r) return;
                remember(r.handle, r.name);
                const text = flat(r.text);
                if (text) feedLines.push(`${'  '.repeat(depth)}↳ ответ ${label(r.handle, r.name)}: ${text}`);
                pushReplies(r.replies, depth + 1);
            });
        };

        // В ленте новые сверху, а читать событиям положено от старых к новым
        [...(events.posts || [])].reverse().forEach(post => {
            if (!post) return;
            remember(post.handle, post.name);
            const text = flat(post.text);
            if (!text && !post.image) return;
            const age = describePostAge(post);
            const when = age ? (age === 'только что' ? 'только что' : `${age} назад`) : '';
            // Полный промпт, а не «прикреплено изображение» без подробностей: модель,
            // читающая саммари в основном чате, иначе не знает, что именно на фото
            const imagePrompt = flat(post.imagePrompt || '');
            const image = post.image ? (imagePrompt ? ` (прикреплено изображение: ${imagePrompt})` : ' (прикреплено изображение)') : '';
            feedLines.push(`${when ? when + ' · ' : ''}${label(post.handle, post.name)}: ${text}${image}`);
            pushReplies(post.replies, 1);
        });

        // --- Личные сообщения ---
        const dmLines = [];
        (events.threads || []).forEach(({ thread, messages }) => {
            if (!messages?.length) return;
            if (thread.isGroup) {
                // Участник мог за эту выгрузку не написать ни слова — в легенду он
                // всё равно нужен, иначе в составе беседы висит нерасшифрованный ник
                const members = (thread.participants || [])
                    .map(h => { remember(h, null); return label(h, null); })
                    .join(', ');
                dmLines.push(`Групповая беседа «${thread.name}»${members ? ` — участники: ${members}` : ''}:`);
            } else {
                remember(thread.handle, thread.name);
                dmLines.push(`Переписка с ${label(thread.handle, thread.name)}:`);
            }
            messages.forEach(m => {
                const isUser = m.sender === 'user';
                // В группе автор каждой реплики свой — брать имя треда нельзя,
                // иначе вся беседа выглядит монологом одного собеседника
                const handle = isUser ? userProfile.handle : (m.sender_handle || thread.handle);
                const name = isUser ? userProfile.name : (m.sender_name || thread.name);
                remember(handle, name);
                // describeDMMessage знает про переводы денег и картинки — у них пустой text
                const text = flat(describeDMMessage(m));
                if (text) dmLines.push(`  ${label(handle, name)}: ${text}`);
            });
        });

        // --- Легенда: только те, кто реально встретился выше ---
        // Голая расшифровка «ник — имя», без пояснений про роли: задача легенды —
        // связать ник с именем, остальное модель и так видит по самим репликам
        const legendLines = seen.map(key => {
            const name = realName(key, null);
            return name ? `@${key} — ${name}` : null;
        }).filter(Boolean);

        return {
            legend: legendLines.join('\n'),
            feed: feedLines.join('\n'),
            dms: dmLines.join('\n'),
        };
    }

    /**
     * Текст едет внутрь маркера [События в соцсети: …] в сообщении чата.
     * Квадратная скобка из поста закрыла бы маркер раньше времени, а угловая —
     * сам скрытый span, и хвост выгрузки вывалился бы в чат видимым текстом.
     */
    function sanitizeContextPayload(text) {
        return String(text || '')
            .replace(/\[/g, '(').replace(/\]/g, ')')
            .replace(/</g, '‹').replace(/>/g, '›');
    }

    /**
     * Помечает текущее состояние ленты и переписок как выгруженное в чат,
     * чтобы следующая выгрузка тем же способом взяла только то, что появилось после.
     * @param {string} mark MARK_SUMMARY или MARK_INSERT
     */
    function markEventsAsSynced(mark = MARK_SUMMARY) {
        if (feedPosts && feedPosts.length > 0) {
            feedPosts.forEach(p => delete p[mark]);
            feedPosts[0][mark] = true;
        }
        (dmThreads || []).forEach(t => {
            if (!t?.messages?.length) return;
            t.messages.forEach(m => delete m[mark]);
            t.messages[t.messages.length - 1][mark] = true;
        });

        saveFeed();
        renderFeed();
        renderDMs();

        if ($('#nova-view-single-dm').hasClass('active')) {
            const handle = $('#nova-view-single-dm').attr('data-thread-handle');
            const index = dmThreads.findIndex(t => t.handle === handle);
            if (index !== -1) openSingleDM(index);
        }
    }

    /**
     * Дописывает скрытый блок контекста в последнее сообщение чата.
     * @param {string} payload текст блока
     * @param {'summary'|'transcript'} kind вид блока — от него зависит подпись и цвет в «Памяти»
     */
    function injectContextIntoChat(payload, kind = 'summary') {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext?.chat) return;

        const label = (CONTEXT_KINDS[kind] || CONTEXT_KINDS.summary).label;
        const hiddenText = `\n<span class="nova-hidden-context" style="display:none;" title="NOVA Context">[${label}: ${sanitizeContextPayload(payload)}]</span>\n`;

        if (stContext.chat.length > 0) {
            stContext.chat[stContext.chat.length - 1].mes += hiddenText;
        } else {
            stContext.chat.push({
                name: 'System',
                is_user: false,
                is_system: true,
                send_date: Date.now(),
                mes: hiddenText,
                extra: { type: 'system' }
            });
        }

        stContext.saveChat();
        if (typeof stContext.updateChatUI === 'function') stContext.updateChatUI();
        if (stContext.eventSource && stContext.eventSource.emit) {
            stContext.eventSource.emit('chat_changed');
        }
        if ($('#nova-view-history').hasClass('active') && typeof renderHistoryTab === 'function') {
            renderHistoryTab();
        }
    }

    /**
     * Вставляет события в чат дословно, без обращения к модели: посты и реплики
     * как есть, плюс легенда с расшифровкой ников. Пересказ теряет детали и стоит
     * генерации — здесь ни того, ни другого.
     */
    function insertEventsTranscript() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext || !stContext.chat || stContext.chat.length === 0) {
            toastr.info("Чат пуст, вставлять переписку некуда.");
            return;
        }

        const events = collectUnsyncedEvents(MARK_INSERT);
        if (!events.posts.length && !events.threads.length) {
            toastr.info("Нет новых событий для вставки.");
            return;
        }

        const { legend, feed, dms } = describeEvents(events);
        if (!feed && !dms) {
            toastr.info("Нет новых событий для вставки.");
            return;
        }

        // Без пустых строк: пустая строка внутри сообщения обрывает HTML-блок
        // в разметке Таверны, и остаток выгрузки становится видимым в чате
        const parts = ['Ниже — дословная выгрузка из соцсети NOVA, а не пересказ.'];
        if (legend) parts.push('КТО ЕСТЬ КТО (ники в соцсети не совпадают с именами):', legend);
        if (feed) parts.push('ЛЕНТА:', feed);
        if (dms) parts.push('ЛИЧНЫЕ СООБЩЕНИЯ:', dms);

        // Сначала блок в чат, потом метки: renderFeed сверяет полоски с содержимым
        // чата и снял бы только что поставленную метку, не найдя блока
        injectContextIntoChat(parts.join('\n'), 'transcript');
        markEventsAsSynced(MARK_INSERT);

        toastr.success(
            `В чат вставлено ${pluralRu(events.posts.length, 'пост', 'поста', 'постов')}` +
            (events.threads.length ? ` и ${pluralRu(events.threads.length, 'диалог', 'диалога', 'диалогов')}` : '') + '.',
            "Переписка"
        );
    }

    /**
     * Дословная вставка ОДНОЙ переписки, без ленты: из открытого диалога логично
     * отправить в ролеплей именно его реплики. Берётся всё, что не уходило в чат
     * раньше, — повторное нажатие не задублирует уже вставленное.
     */
    function insertThreadTranscript(index) {
        const thread = dmThreads[index];
        if (!thread?.messages?.length) {
            toastr.info("В этой переписке пока нечего вставлять.");
            return;
        }

        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext || !stContext.chat || stContext.chat.length === 0) {
            toastr.info("Чат пуст, вставлять переписку некуда.");
            return;
        }

        // Считаем от голубой полоски — своей, не от зелёной: пересказ и вставка
        // ведут учёт порознь, и саммари не должно «съедать» невставленное
        let lastIdx = -1;
        for (let i = thread.messages.length - 1; i >= 0; i--) {
            if (thread.messages[i][MARK_INSERT]) { lastIdx = i; break; }
        }
        // Без метки берём тред целиком: кнопка нажата осознанно и именно по этому диалогу,
        // обрезать его на последних 15 сообщениях было бы потерей по своей инициативе
        const messages = lastIdx !== -1 ? thread.messages.slice(lastIdx + 1) : thread.messages.slice();
        if (!messages.length) {
            toastr.info("Все сообщения этой переписки уже вставлены в чат.");
            return;
        }

        const { legend, dms } = describeEvents({ posts: [], threads: [{ thread, messages }] });
        if (!dms) {
            toastr.info("В этой переписке пока нечего вставлять.");
            return;
        }

        const parts = ['Ниже — дословная переписка из личных сообщений NOVA, а не пересказ.'];
        if (legend) parts.push('КТО ЕСТЬ КТО (ники в соцсети не совпадают с именами):', legend);
        parts.push(dms);

        // Сначала блок в чат: перерисовка сверяет полоски с содержимым чата
        // и сняла бы метку, поставленную раньше вставки
        injectContextIntoChat(parts.join('\n'), 'transcript');

        // Двигаем метку только у этого треда: лента и остальные диалоги
        // должны остаться непрочитанными для кнопок в «Памяти»
        thread.messages.forEach(m => delete m[MARK_INSERT]);
        thread.messages[thread.messages.length - 1][MARK_INSERT] = true;
        saveFeed();

        // Перерисовываем открытый диалог, чтобы голубая полоска встала на место сразу
        openSingleDM(index);
        renderDMs();

        toastr.success(
            `В чат вставлено ${pluralRu(messages.length, 'сообщение', 'сообщения', 'сообщений')} из переписки с ${thread.name}.`,
            "Переписка"
        );
    }

    async function generateContextSummary(isAuto = false) {
        console.log("[NOVA] generateContextSummary called", { isAuto });
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext || !stContext.chat || stContext.chat.length === 0) {
            console.log("[NOVA] Chat is empty");
            if (!isAuto) toastr.info("Чат пуст, синхронизация отменена.");
            return;
        }
        
        console.log("[NOVA] Chat has messages, proceeding to sync");
        if (!isAuto) toastr.info("Синхронизация контекста NOVA...", "NOVA", {timeOut: 3000});

        try {
            const activeProfiles = typeof getActiveProfiles === 'function' ? getActiveProfiles() : [];
            
            const userProfile = activeProfiles.find(ap => ap.isUser) || { name: 'Игрок' };

            // 1. Последний блок контекста из чата — любого вида: пересказ не должен
            // повторять ни прошлый пересказ, ни то, что уже вставлено дословно
            let previousSummary = null;
            for (let i = stContext.chat.length - 1; i >= 0; i--) {
                const msg = stContext.chat[i];
                if (!msg?.mes) continue;
                let match;
                let lastMatch = null;
                const localRegex = contextMarkerRegex();
                while ((match = localRegex.exec(msg.mes)) !== null) {
                    lastMatch = match[2];
                }
                if (lastMatch) {
                    previousSummary = lastMatch;
                    break;
                }
            }

            // Предыдущим блоком может оказаться дословная выгрузка на много килобайт.
            // Здесь он нужен только чтобы не пересказать то же самое второй раз —
            // хвоста хватает, а целиком он бы съел половину контекста.
            if (previousSummary && previousSummary.length > 1200) {
                previousSummary = '…' + previousSummary.slice(-1200);
            }

            // 2. Новые события — тем же сборщиком, что и дословная вставка
            const events = collectUnsyncedEvents();
            const { legend, feed: feedContext, dms: dmContext } = describeEvents(events);

            // 3. Abort if no new context
            if (!feedContext && !dmContext) {
                console.log("[NOVA] No new events to summarize.");
                if (!isAuto) toastr.info("Нет новых событий для пересказа.");
                return;
            }

            let promptText = NovaPrompts.generateSocialMediaSummary(feedContext, dmContext, novaSummarySize, userProfile.name, previousSummary, legend);
            let summary = await callAI(promptText);
            // Через общий вырезатель: своя регулярка тут не ловила случай с «Начинать ответ с»,
            // когда открывающий тег остаётся в преднаполнении и в ответ не возвращается
            summary = stripReasoningBlocks(summary).replace(/\s+/g, ' ').trim();
            if (summary && summary.length > 0) {
                // Порядок важен: renderFeed внутри markEventsAsSynced сверяет полоски
                // с содержимым чата и снял бы метку, поставленную до вставки блока
                injectContextIntoChat(summary, 'summary');
                markEventsAsSynced(MARK_SUMMARY);
                if (!isAuto) toastr.success("События добавлены в чат как системное сообщение!", "Синхронизация");
            } else if (!isAuto) {
                toastr.warning("Модель вернула пустой пересказ — события остались непрочитанными.");
            }
        } catch (e) {
            console.error("[NOVA] Sync error:", e);
            if (!isAuto) toastr.error("Не удалось синхронизировать контекст. Ошибка: " + e.message, "Ошибка");
        }
    }

    // Достаём текст из любого формата ответа бэкенда (OpenAI / Claude / textgen / ...)
    function extractTextFromResponse(response) {
        if (response === null || response === undefined) return '';
        if (typeof response === 'string') return response;

        // ExtractedData из ST-сервисов
        if (typeof response.content === 'string') return response.content;

        const choice = Array.isArray(response.choices) ? response.choices[0] : null;
        if (choice) {
            if (typeof choice.message?.content === 'string') return choice.message.content;
            if (Array.isArray(choice.message?.content)) {
                return choice.message.content.map(part => part?.text || '').join('');
            }
            if (typeof choice.text === 'string') return choice.text;
        }

        // Claude native
        if (Array.isArray(response.content)) {
            return response.content.filter(p => p?.type !== 'thinking').map(p => p?.text || '').join('');
        }
        // Google / textgen
        if (typeof response.text === 'string') return response.text;
        if (Array.isArray(response.candidates)) {
            return response.candidates[0]?.content?.parts?.map(p => p?.text || '').join('') || '';
        }
        if (Array.isArray(response.results)) {
            return response.results[0]?.text || '';
        }

        return '';
    }

    // Значения по умолчанию для настроек генерации.
    // Думалка на минимуме + жёсткий лимит ответа: у reasoning-моделей (Gemini 3, o-series и т.п.)
    // размышления тратят тот же бюджет, что и текст, поэтому «Авто» стабильно рвёт JSON на полуслове.
    const NOVA_GEN_DEFAULTS = {
        max_tokens: '2500',
        thinking_budget: 'min',
        // Сколько прошлого уходит модели в промпт. У ленты лимит был всегда (12 постов),
        // а переписка отдавалась ЦЕЛИКОМ — с каждым сообщением промпт рос, и на длинных
        // тредах это упиралось в лимиты провайдера (те самые 429 и обрывы JSON).
        // Оба вынесены в ползунки: у кого контекст большой — поднимет, у кого 429 — опустит.
        feed_history_size: '12',
        dm_history_size: '40',
        // Просьба в промпте — единственный рычаг, который доезжает через прокси,
        // где Таверна не передаёт ни reasoning_effort, ни include_reasoning.
        // Английский в размышлениях заметно дешевле: кириллица жрёт в разы больше токенов на символ.
        thinking_hint: 'Think in English only — this saves tokens. Keep your reasoning to a single paragraph and '
            + 'STRICTLY within 200 tokens. This limit applies to your thinking ONLY: the content you generate must '
            + 'still follow the language rules stated above.',
        // Своя копия системы рассуждений из Таверны (Форматирование → Рассуждения + Разное),
        // чтобы NOVA не зависел от глобальных настроек чата и настраивался отдельно.
        start_reply_with: '',
        reasoning_prefix: '<think>',
        reasoning_suffix: '</think>',
        thinking_prompt: `<thinking>
Inside the thinking block, work through these points in English, ONE SHORT LINE each:
- Scene: what is happening in the RP right now
- Tone: the current mood of the feed
- Who posts: which characters have a real reason to post, and why
- Anti-looping: what must NOT repeat from the previous posts
- Anti-robot: no analytical or mechanical phrasing, keep it human
Then close the thinking block and output ONLY the JSON, with nothing after it.
</thinking>`,
    };

    function getGenSetting(ctx, key) {
        const value = ctx?.extensionSettings?.NOVA?.[key];
        return (value === undefined || value === null || value === '') ? NOVA_GEN_DEFAULTS[key] : value;
    }

    /**
     * Числовой лимит истории из настроек. Ноль на ползунке = «без ограничения»
     * (Infinity), чтобы slice просто ничего не отрезал.
     */
    function getHistoryLimit(key) {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const raw = parseInt(getGenSetting(ctx, key), 10);
        if (!Number.isFinite(raw) || raw < 0) return parseInt(NOVA_GEN_DEFAULTS[key], 10);
        return raw === 0 ? Infinity : raw;
    }

    // ─── Генерация изображений ────────────────────────────────────────────────

    // Пресет по умолчанию. Это ХУДОЖЕСТВЕННАЯ часть: контракт JSON и порядок сборки
    // описания живут в prompts.js, поэтому пресет можно переписать как угодно,
    // не сломав разбор ответа.
    const NOVA_IMAGE_PRESET_DEFAULT = `Act as a virtual photographer for the characters in this roleplay. Whenever a character takes a selfie, photographs their surroundings, or sends someone a photo, this governs what goes into the "prompt" field — the goal is a photo that reads as a real, unposed phone snapshot, never a staged studio portrait or a clean 3D render.

CAMERA AND ANGLE — rotate through these, never repeat the same one twice in a row:
- Selfie at arm's length (front camera, slight wide-lens distortion on the face).
- Mirror selfie in a smudged bathroom mirror, phone visible in hand.
- Phone propped on a shelf or ledge, self-timer, wider shot.
- Shot out a window or across a room.
- No face at all — food, a half-eaten breakfast with only a hand in frame, an object, a view.
- A pet already established in the story.

SHOT FLAWS (pick 1–2 per photo) — a perfect composition reads as fake: the top of the head cropped off by the frame edge, a tilted horizon, a blurred finger at the edge of the frame, a random passerby in the background, harsh flash glare, a lens flare.

VARIETY: never send two close-up face selfies back to back. If the previous photo was a close-up of the face, this one has to be a detail shot (shoes, an object on a table) or a shot of the surroundings instead.

EMOTION — through muscles, never through labels. Words like "sad", "happy", "angry" flatten the face; describe what the muscles are actually doing:
- Instead of "happy": eyes narrowed, faint creases forming at their corners, mouth corners lifted unevenly, face relaxed.
- Instead of "angry": brows drawn together, jaw set, lips pressed into a thin line, a sharp look from under lowered brows.
Always say where the eyes are pointed: straight into the lens, at the phone screen, past the camera into empty space, at their own reflection.

CHARACTERS — first names only, no surnames. Never describe fixed traits (eye colour, hair colour, facial features, body build) — those come from the reference photo and words only fight it. Describe only what changes: clothing (a rumpled t-shirt, an unbuttoned shirt), condition (damp skin, hair mussed by wind), and pose. Nobody floats — give them a point of contact (leaning on a wall, sitting on the edge of a tub, weight on one leg), and the hand holding the phone is always either extended or bent at the elbow.

INTIMACY AND MOOD — for a romantic, charged, or suggestive scene, the words nude, sexy, erotic, naked are off-limits. Build the mood through implication and light instead: deep shadow over the lower body, framing cropped at the collarbone or shoulders, steam on a mirror, a strap slipping off one shoulder, a sheet balled in a fist, half-light, neon through a window, backlight turning the figure into a silhouette.

ASSEMBLING THE PROMPT: one dense paragraph, 100–200 words, comma-separated, no line breaks. Order: camera/angle, subject's NAME IN CAPS, shot flaw, pose and facial-muscle physics (emotion), clothing, light and background.

Append this block VERBATIM at the very end of every prompt, after the scene description — it locks in the intended look and blocks unwanted output:
NEGATIVE PROMPT: 3D render, photorealism, heavy dark shadows, low-key lighting, thick lineart, cel-shading, matte finish, flat colors, messy watercolor.`;

    const squashSpaces = text => String(text || '').replace(/\s+/g, ' ').trim();

    // Прошлые дефолты — дословно, чтобы отличить нетронутый пресет от переписанного
    // руками. Сравнение по одной фразе затёрло бы и чужую работу.
    const LEGACY_PRESET_TEXTS = [
        // самый первый, расплывчатый и на русском
        `Фотографии выглядят так, будто их правда сняли на телефон и выложили в соцсеть:
живой любительский кадр, естественный свет, слегка небрежная композиция, без студийного глянца.
Поводы обычные: селфи, еда, вид из окна, питомец, купленная вещь, случайный момент дня.
Не приукрашивай: если персонажу сейчас плохо, это видно и на фото.
Внешность персонажа бери из его карточки и описывай подробно — цвет волос и глаз, телосложение, одежду,
иначе на каждой картинке будет новый человек.`,
        // второй: типы кадра были тут, а порядок сборки — зашит в код
        `PICK THE SHOT TYPE that fits what is happening right now — do not default to a selfie every time:
1. Selfie — arm extended, looking into the front camera, slight wide-lens distortion.
2. Mirror selfie — standing at a mirror, phone visible in hand, back camera.
3. Taken by someone else — natural pose or caught mid-activity, shot from across the room.
4. Taken unnoticed — the subject does not know they are being photographed: shot from a distance, part of the frame blocked by something in the foreground.
5. No faces at all — food, a view from a window, an object, a hand holding a cup.
6. Pet — an animal that already exists in the story.

WHAT MAKES IT LOOK REAL:
- An ordinary reason to post, not a photoshoot: what they are eating, where they are stuck, what they just bought.
- Imperfect framing — slightly tilted horizon, subject off-centre, a cropped elbow.
- Do not prettify. If the character is having a bad day, the photo shows it: bad light, tired face, messy room.`,
        // третий: полная версия с порядком сборки промпта и ночным разделом —
        // заменена на протокол "виртуального фотографа" (см. NOVA_IMAGE_PRESET_DEFAULT)
        `PICK THE SHOT TYPE that fits what is happening right now — do not default to a selfie every time:
1. Selfie — arm extended, looking into the front camera, slight wide-lens distortion.
2. Mirror selfie — standing at a mirror, phone visible in hand, back camera.
3. Taken by someone else — natural pose or caught mid-activity, shot from across the room.
4. Taken unnoticed — the subject does not know they are being photographed: shot from a distance, part of the frame blocked by something in the foreground.
5. No faces at all — food, a view from a window, an object, a hand holding a cup.
6. Pet — an animal that already exists in the story.

BUILD THE PROMPT IN THIS ORDER:
1. CAMERA: shot type, angle and phone-camera artefact — "smartphone selfie camera, high angle", "mirror selfie", "candid snapshot, slight motion blur", "zoomed-in shot from across the room, foreground partly blocking the lens".
2. WHO IS IN FRAME: lead with the FIRST NAME IN CAPS (ANNA, KENTO). Always name distinguishing marks — tattoos, scars, piercings, glasses. Mention hair only when the scene changed it: bed hair, wet, windblown. Give the expression.
3. OUTFIT — MANDATORY: it must match what the character is actually wearing in the story right now. Name the COLOUR of every item plus fabric, fit and condition ("oversized washed-black graphic tee", "unzipped grey hoodie"), and do not forget accessories.
4. POSE AND HANDS: what the hands are doing — holding the phone, adjusting hair, holding a cup, or nothing in particular for an unnoticed shot. Add "anatomically correct proportions, five fingers per visible hand".
5. ENVIRONMENT: a separate sentence, an ordinary place — messy bedroom, car interior, cafe table, bus window, office corridor. For an unnoticed shot, name what blocks the lens ("out-of-focus menu edge in the foreground").
6. LIGHT: direct phone flash, ring-light catch in the eyes, sunlight through a car window, a room lit only by a monitor.

ONE single photograph. No text overlays, no watermarks, no collages, no split panels.

WHAT MAKES IT LOOK REAL:
- An ordinary reason to post, not a photoshoot: what they are eating, where they are stuck, what they just bought.
- Imperfect framing — slightly tilted horizon, subject off-centre, a cropped elbow.
- Do not prettify. If the character is having a bad day, the photo shows it: bad light, tired face, messy room.

LATE-NIGHT / PRIVATE SNAPSHOT — in private messages only, and only when the mood is genuinely there:
- Camera: low-light phone camera, grainy flash.
- Visual noise, at least three of: tangled sheets, messy hair, heavy shadow, blurred foreground, tight crop.
- Concealment, at least two of: deep shadow, blanket pulled up, face half-hidden behind the phone, low lying-down angle.
- Suggestion comes from framing and light only. Never anything explicit.`,
    ].map(squashSpaces);

    // Стиль вынесен отдельным полем: его меняют часто, а протокол выше — почти никогда.
    // Реализм тут не обязателен — это просто нейтральная отправная точка.
    const NOVA_IMAGE_STYLE_DEFAULT = 'Semi-realistic high-end digital painting, modern Korean illustrator aesthetic, high-key overexposed pastel color grading, blinding white environmental light with vibrant saturated accents, lineless art, extremely delicate contours, translucent subsurface scattering, ultra-fine dynamic wispy brushstrokes, hyper-glossy rendering, sharp luminous specular glints, detailed glassy textures, blinding ethereal backlighting, intense high-key illumination, soft luminous bloom, heavy digital noise, prominent film grain overlay, smooth airbrush blending mixed with sharp micro-detailing.';

    // Прошлые дефолты стиля — дословно, как и LEGACY_PRESET_TEXTS выше: чтобы
    // менять текст даже под тем же именем "Default", не трогая стиль, который
    // пользователь всё-таки написал сам под этим именем ПОСЛЕ миграции
    const LEGACY_STYLE_TEXTS = [
        'semi-realistic, candid amateur smartphone photography, natural imperfect lighting',
        `Fully rendered painterly digital illustration, semi-realistic faceted brushwork, natural muted neutral
color grading with soft cool-warm balance, low-to-moderate desaturation, no outlines or contour lines, forms
built entirely from hard-edged geometric color patches meeting directly, angular chunky brushstrokes standing
in for fine texture and fur detail, flat plane shading with minimal blending between adjacent color shapes,
soft directional natural lighting with gentle falloff, semi-realistic proportions with detailed painterly eye
rendering and small soft catchlights, subtle painterly grain, crisp clean edges throughout with no visible
sketch or construction lines.`,
    ].map(squashSpaces);

    const NOVA_IMAGE_DEFAULTS = {
        enabled: false,
        max_per_batch: 1,
        profiles: [],
        active_profile: '',
        presets: [],
        active_preset: '',
        styles: [],
        active_style: '',
        references: [],
        references_enabled: true,
        // Брать подключение из расширения sillyimages, а не заводить своё
        use_sillyimages: false,
        // Хэндлы тех, кому фото запрещено. Храним запрет, а не разрешение:
        // новый персонаж в чате сразу умеет фото, и настройка не требуется
        photo_blocked: [],
    };

    // Приписка перед промптом, когда к запросу приложены референсы. Без неё модель
    // считает их «вдохновением» и рисует похожего, но другого человека.
    const NOVA_REF_INSTRUCTION = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). '
        + 'You MUST precisely copy their face structure, eye color, hair color and style, skin tone, body type and '
        + 'distinctive features. Do not deviate from the reference appearances.]';

    // Больше пяти картинок в одном запросе модели только мешают: она начинает
    // смешивать лица. Столько же держит и sillyimages.
    const NOVA_MAX_REFERENCES = 5;

    // Размеры OpenAI-совместимых эндпоинтов и соотношения сторон Gemini
    const NOVA_IMAGE_SIZES = ['1024x1024', '1792x1024', '1024x1792', '512x512'];
    const NOVA_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

    /** Блок image_gen в настройках. Создаёт его при первом обращении и чинит недостающие поля. */
    function getImageSettings() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return { ...NOVA_IMAGE_DEFAULTS };
        if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};

        const store = ctx.extensionSettings.NOVA;
        if (!store.image_gen || typeof store.image_gen !== 'object') {
            store.image_gen = structuredClone(NOVA_IMAGE_DEFAULTS);
        }
        const cfg = store.image_gen;
        for (const [key, value] of Object.entries(NOVA_IMAGE_DEFAULTS)) {
            if (cfg[key] === undefined) cfg[key] = Array.isArray(value) ? [] : value;
        }
        if (!Array.isArray(cfg.profiles)) cfg.profiles = [];
        if (!Array.isArray(cfg.presets)) cfg.presets = [];
        if (!Array.isArray(cfg.styles)) cfg.styles = [];
        if (!Array.isArray(cfg.references)) cfg.references = [];
        if (!Array.isArray(cfg.photo_blocked)) cfg.photo_blocked = [];

        // Стартовый пресет: без него негде писать правила заполнения тега
        if (cfg.presets.length === 0) {
            const preset = {
                id: `preset_${Date.now()}`,
                name: 'Default',
                prompt: NOVA_IMAGE_PRESET_DEFAULT,
            };
            cfg.presets.push(preset);
            cfg.active_preset = preset.id;
        }
        cfg.presets.forEach(p => {
            // Два способа поймать устаревший дефолт:
            // 1) текст дословно совпадает с одним из старых дефолтов — сработает даже
            //    если пресет успели переименовать;
            // 2) имя всё ещё дефолтное ("Фото с телефона") — тут дословно НЕ
            //    сверяем и заменяем принудительно, даже если текст внутри правили
            //    руками: имя "Фото с телефона" не предназначено для ручных
            //    пресетов, так что раз оно осталось — это сид, а не чья-то работа
            const isLegacyText = typeof p.prompt === 'string' && LEGACY_PRESET_TEXTS.includes(squashSpaces(p.prompt));
            const isLegacyName = p.name === 'Фото с телефона';
            if (isLegacyText || isLegacyName) {
                p.prompt = NOVA_IMAGE_PRESET_DEFAULT;
                p.name = 'Default';
            }
        });

        // Стартовый стиль: раньше стиль жил внутри пресета — при первом переходе
        // на отдельный список переносим то, что там уже было написано, а не теряем его
        if (cfg.styles.length === 0) {
            const legacyStyle = String(
                (cfg.presets.find(p => p.id === cfg.active_preset) || cfg.presets[0])?.style || ''
            ).trim() || NOVA_IMAGE_STYLE_DEFAULT;
            const style = {
                id: `style_${Date.now()}`,
                name: 'Default',
                style: legacyStyle,
                preview: '',
            };
            cfg.styles.push(style);
            cfg.active_style = style.id;
        }
        cfg.styles.forEach(s => {
            // Старый сид-стиль назывался "Фото с телефона" — переименовываем в
            // English, как и одноимённый пресет выше
            if (s.name === 'Фото с телефона') s.name = 'Default';
            // Текст стиля меняем по содержимому (не по имени, в отличие от пресета
            // выше) — так стиль, который пользователь напишет под именем "Default"
            // СЕЙЧАС, не затрётся снова на следующей перезагрузке
            if (typeof s.style === 'string' && LEGACY_STYLE_TEXTS.includes(squashSpaces(s.style))) {
                s.style = NOVA_IMAGE_STYLE_DEFAULT;
            }
        });
        return cfg;
    }

    function saveImageSettings() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        ctx?.saveSettingsDebounced?.();
    }

    // У Naistera нет эндпоинта со списком моделей — он фиксированный, из её документации
    const NAISTERA_MODELS = ['grok', 'nano banana', 'nano banana pro', 'nano banana 2'];

    // По этим словам отличаем рисующие модели от языковых в общем списке /v1/models
    const IMAGE_MODEL_HINTS = [
        'dall-e', 'gpt-image', 'imagen', 'nano-banana', 'nano banana', 'flux', 'stable-diffusion',
        'sdxl', 'midjourney', 'ideogram', 'seedream', 'hidream', 'dreamshaper', 'qwen-image',
        'wanx', 'image', 'draw', 'paint',
    ];

    /**
     * Тянет список моделей у провайдера, чтобы не заставлять вписывать их руками.
     * @returns {Promise<string[]>}
     */
    async function fetchImageModels(profile) {
        if (!profile) throw new Error('Сначала заполните профиль');
        if (profile.apiType === 'naistera') return NAISTERA_MODELS.slice();

        const endpoint = String(profile.endpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) throw new Error('Не заполнен URL эндпоинта');
        const apiKey = String(profile.apiKey || '').trim();

        const isGemini = profile.apiType === 'gemini';
        const url = isGemini ? `${endpoint}/v1beta/models` : `${endpoint}/v1/models`;
        const headers = isGemini
            ? { 'Authorization': `Bearer ${apiKey}`, 'x-goog-api-key': apiKey }
            : { 'Authorization': `Bearer ${apiKey}` };

        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(await imageApiErrorText(res));
        const data = await res.json().catch(() => null);

        const raw = isGemini
            ? (data?.models || []).map(m => String(m?.name || '').replace(/^models\//, ''))
            : (data?.data || []).map(m => String(m?.id || ''));
        const all = raw.filter(Boolean).sort();
        if (!all.length) throw new Error('Провайдер вернул пустой список моделей');

        // Показываем только рисующие, но если фильтр всё выкосил — отдаём всё:
        // лучше длинный список, чем пустой
        const drawing = all.filter(id => IMAGE_MODEL_HINTS.some(h => id.toLowerCase().includes(h)));
        return drawing.length ? drawing : all;
    }

    /**
     * У OpenAI-эндпоинта нет соотношения сторон — только фиксированные размеры.
     * Переводим то, что выбрала модель в теге, в ближайший доступный: настройка
     * «квадрат/горизонт/вертикаль» руками тут лишняя, кадр задаёт сам тег.
     */
    function aspectToOpenAISize(aspect) {
        const [w, h] = String(aspect || '1:1').split(':').map(Number);
        if (!w || !h) return '1024x1024';
        const ratio = w / h;
        if (ratio > 1.2) return '1792x1024';
        if (ratio < 0.85) return '1024x1792';
        return '1024x1024';
    }

    // Ключ настроек расширения sillyimages (его MODULE_NAME)
    const SILLYIMAGES_KEY = 'inline_image_gen';

    /**
     * Забирает подключение из sillyimages вместо того, чтобы заставлять вводить
     * эндпоинт, ключ и модель второй раз. Читаем ТОЛЬКО настройки: его функции
     * лежат внутри IIFE и снаружи недоступны, вызвать их нельзя при всём желании.
     *
     * Ключи там разложены по слотам на каждый тип API (openaiEndpoint, geminiEndpoint…),
     * со старыми общими полями как запасным вариантом.
     * @returns {object|null} профиль в формате NOVA
     */
    function readSillyImagesProfile() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const s = ctx?.extensionSettings?.[SILLYIMAGES_KEY];
        if (!s) return null;

        const type = s.apiType === 'gemini' ? 'gemini' : (s.apiType === 'naistera' ? 'naistera' : 'openai');
        const endpoint = s[`${type}Endpoint`] || s.endpoint || (type === 'naistera' ? 'https://naistera.org' : '');
        const apiKey = s[`${type}ApiKey`] || s.apiKey || '';
        const model = s[`${type}Model`] || s.model || (type === 'naistera' ? 'grok' : '');
        if (!endpoint || !apiKey) return null;

        return {
            id: '__sillyimages',
            name: 'из sillyimages',
            apiType: type,
            endpoint,
            apiKey,
            model,
            size: s.size || '1024x1024',
            // У Naistera своё поле соотношения сторон
            aspect_ratio: (type === 'naistera' ? s.naisteraAspectRatio : s.aspectRatio) || '1:1',
            image_size: s.imageSize || '1K',
            fromSillyImages: true,
        };
    }

    function getActiveImageProfile() {
        const cfg = getImageSettings();
        if (cfg.use_sillyimages) {
            const borrowed = readSillyImagesProfile();
            if (borrowed) return borrowed;
        }
        return cfg.profiles.find(p => p.id === cfg.active_profile) || cfg.profiles[0] || null;
    }

    function getActiveImagePreset() {
        const cfg = getImageSettings();
        return cfg.presets.find(p => p.id === cfg.active_preset) || cfg.presets[0] || null;
    }

    function getActiveImageStyle() {
        const cfg = getImageSettings();
        return cfg.styles.find(s => s.id === cfg.active_style) || cfg.styles[0] || null;
    }

    /**
     * Сколько картинок разрешено за одну генерацию. 0 — фича выключена целиком:
     * тогда и блок про фото в промпт не уезжает, и модель про них даже не знает.
     */
    function getImageBudget() {
        const cfg = getImageSettings();
        if (!cfg.enabled) return 0;
        if (!getActiveImageProfile()) return 0;
        const n = parseInt(cfg.max_per_batch, 10);
        return Number.isFinite(n) && n > 0 ? Math.min(n, 5) : 0;
    }

    /** Может ли этот персонаж прикладывать фото. По умолчанию — да. */
    function canAttachPhoto(handle) {
        const key = normHandle(handle);
        if (!key) return false;
        return !getImageSettings().photo_blocked.map(normHandle).includes(key);
    }

    /**
     * Кому фото разрешено — из числа тех, кто вообще участвует в ленте.
     * Игрока исключаем: свои картинки он прикладывает руками.
     */
    function getPhotoAllowedProfiles() {
        return getActiveProfiles().filter(p => !p.isUser && canAttachPhoto(p.handle));
    }

    /** Готовый блок инструкций про фото для промпта — пустая строка, если выключено. */
    function buildImageInstruction(target = 'feed') {
        const budget = getImageBudget();
        if (!budget) return '';

        // Список разрешённых уходит в промпт только когда кого-то реально ограничили:
        // иначе это лишние токены в каждом запросе
        const everyone = getActiveProfiles().filter(p => !p.isUser);
        const allowed = getPhotoAllowedProfiles();
        const restricted = allowed.length < everyone.length;
        if (restricted && !allowed.length) return '';

        // Правило про внешность зависит от того, дойдёт ли до генератора референс:
        // с ним словесное описание лица только спорит с образцом
        const cfg = getImageSettings();
        const profile = getActiveImageProfile();
        const withReferences = cfg.references_enabled !== false
            && (profile?.apiType === 'gemini' || profile?.apiType === 'naistera')
            && getActiveReferences().some(r => r.image);

        const preset = getActiveImagePreset();
        return NovaPrompts.imageInstructionBlock({
            maxImages: budget,
            target,
            allowedHandles: restricted ? allowed.map(p => p.handle).join(', ') : '',
            protocol: preset?.prompt || '',
            style: getActiveImageStyle()?.style || '',
            withReferences,
        });
    }

    // ─── Референсы внешности ──────────────────────────────────────────────────

    /** Приводит слот референса к полному виду: старые записи могли не иметь части полей. */
    function normalizeReference(raw) {
        const src = (raw && typeof raw === 'object') ? raw : {};
        return {
            id: src.id || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: String(src.name || '').trim(),
            image: String(src.image || ''),
            // К каким авторам привязан — тогда референс уходит автоматически,
            // когда фото публикует именно этот персонаж
            handles: Array.isArray(src.handles) ? src.handles.map(normHandle).filter(Boolean) : [],
            keywords: Array.isArray(src.keywords)
                ? src.keywords.map(k => String(k).trim()).filter(Boolean)
                : String(src.keywords || '').split(',').map(k => k.trim()).filter(Boolean),
            mode: src.mode === 'always' ? 'always' : 'auto',
            label: src.label === true,
            // В архиве референс полностью сохранён, но в генерацию не уходит —
            // мягкая альтернатива удалению для тех, кто нужен не в каждом чате
            archived: src.archived === true,
        };
    }

    /** ВСЕ слоты, включая архивные — нужно редактору настроек. */
    function getReferences() {
        const cfg = getImageSettings();
        cfg.references = cfg.references.map(normalizeReference);
        return cfg.references;
    }

    /** Только те, что реально участвуют в генерации. */
    function getActiveReferences() {
        return getReferences().filter(r => !r.archived);
    }

    /**
     * Режет текст на слова. \p{L} вместо \w — иначе кириллица распадается на куски,
     * а вся затея с русскими именами в ключевых словах разваливается.
     */
    function tokenizeForMatch(text) {
        return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    }

    /**
     * Ключевое слово встречается в тексте ЦЕЛЫМ словом.
     *
     * Наивная проверка через includes() ловит корни внутри чужих слов: «ann» триггерится
     * на «banner» и «announcement», «кот» — на «который». Поэтому сравниваем
     * последовательности слов, а не подстроки. Ключ из нескольких слов должен идти
     * подряд: «нанами кенто» не сработает на «нанами сказал кенто».
     */
    function keywordMatches(keyword, promptTokens) {
        const needle = tokenizeForMatch(keyword);
        if (!needle.length) return false;
        for (let i = 0; i + needle.length <= promptTokens.length; i++) {
            if (needle.every((word, j) => promptTokens[i + j] === word)) return true;
        }
        return false;
    }

    /**
     * Какие референсы приложить к этому кадру.
     *
     * В отличие от sillyimages, где приходится угадывать персонажа по словам в промпте,
     * NOVA точно знает автора поста — поэтому его собственный референс подставляется
     * без всякого совпадения. Ключевые слова нужны только для тех, кто попал в кадр,
     * но пост не писал.
     */
    /**
     * @param {string} authorHandle — кто публикует пост. Больше НЕ используется для
     * автоматического подбора референса — см. комментарий ниже, почему.
     */
    function matchReferences(authorHandle, imagePrompt) {
        const cfg = getImageSettings();
        if (cfg.references_enabled === false) return [];

        const refs = getActiveReferences().filter(r => r.image);
        const promptTokens = tokenizeForMatch(imagePrompt);
        const picked = [];
        const seen = new Set();

        const take = ref => {
            if (seen.has(ref.id)) return;
            seen.add(ref.id);
            picked.push(ref);
        };

        // Порядок важен: при упоре в лимит обрезается хвост, а не главное лицо.
        //
        // Референс автора поста раньше подставлялся ВСЕГДА, независимо от того, о ком
        // на самом деле фото — расчёт был на селфи. Но автор далеко не всегда его
        // герой: Годжо может сфотографировать спящую Нанами и подписать это своей
        // шуткой — тогда в кадре она, а не он, и вставлять лицо Годжо было прямой
        // ошибкой (баг: референс автора всегда лип к фото, даже когда речь шла только
        // о ком-то другом). Протокол промпта требует называть героя кадра ИМЕНЕМ
        // ЗАГЛАВНЫМИ («WHO IS IN FRAME: lead with the FIRST NAME IN CAPS») — поэтому
        // ключевых слов достаточно и для селфи, и для чужого кадра: подставляется тот,
        // кто действительно назван на фото, а не тот, кто его выложил.
        refs.filter(r => r.mode === 'always').forEach(take);
        refs.filter(r => r.keywords.some(k => k.length >= 2 && keywordMatches(k, promptTokens))).forEach(take);

        return picked.slice(0, NOVA_MAX_REFERENCES);
    }

    /** Читает сохранённый файл референса и отдаёт чистый base64 без префикса data:. */
    async function referenceToBase64(path) {
        const res = await fetch(path.startsWith('/') || path.startsWith('http') ? path : `/${path}`);
        if (!res.ok) throw new Error(`Референс не открывается: ${res.status}`);
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Не удалось прочитать референс'));
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Впечатывает имя прямо в картинку. Когда референсов несколько, модель иначе
     * не понимает, какое лицо кому принадлежит, и смешивает персонажей.
     */
    function drawLabelOnImage(dataUrl, text) {
        return new Promise((resolve) => {
            const img = new Image();
            // Подпись — украшение: если что-то пошло не так, отдаём картинку как есть
            img.onerror = () => resolve(dataUrl);
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);

                    const pad = Math.max(6, Math.round(img.width * 0.02));
                    const fontSize = Math.max(14, Math.round(img.width * 0.07));
                    ctx.font = `bold ${fontSize}px sans-serif`;
                    ctx.textBaseline = 'bottom';

                    const metrics = ctx.measureText(text);
                    ctx.fillStyle = 'rgba(0,0,0,0.65)';
                    ctx.fillRect(0, img.height - fontSize - pad * 2, metrics.width + pad * 2, fontSize + pad * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(text, pad, img.height - pad);

                    resolve(canvas.toDataURL('image/jpeg', 0.9));
                } catch {
                    resolve(dataUrl);
                }
            };
            img.src = dataUrl;
        });
    }

    /** Готовит референсы к отправке: читает файлы, при необходимости подписывает. */
    async function prepareReferences(refs) {
        const out = [];
        for (const ref of refs) {
            try {
                let base64 = await referenceToBase64(ref.image);
                if (ref.label && ref.name) {
                    const labeled = await drawLabelOnImage(`data:image/jpeg;base64,${base64}`, ref.name);
                    base64 = labeled.split(',')[1] || base64;
                }
                if (base64) out.push(base64);
            } catch (e) {
                console.warn(`[NOVA] Референс «${ref.name}» пропущен`, e);
            }
        }
        return out;
    }

    /**
     * Вытаскивает из текста тег генерации картинки — в том же виде, что понимает
     * sillyimages, чтобы привычка и готовые промпты работали и здесь:
     *   <img data-iig-instruction='{"prompt":"...","aspect_ratio":"3:4"}' src="[IMG:GEN]">
     *   [IMG:GEN:{"prompt":"..."}]                                        (старый формат)
     *
     * Разбирать сам тег обязана NOVA: sillyimages сканирует сообщения чата,
     * а посты ленты живут в своей панели и до него не доходят.
     *
     * @returns {{tag: string, data: object}|null} tag — что вырезать из текста
     */
    function extractImageTag(text) {
        const source = String(text || '');
        if (!source.includes('IMG:GEN')) return null;

        const parseJson = raw => {
            if (!raw) return null;
            // Убираем экранирование кавычек, которое добавляют LLM (в т.ч. множественные слэши)
            const cleaned = String(raw)
                .replace(/\\+"/g, '"')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim();
            
            try { return JSON.parse(cleaned); } catch {}
            try { return JSON.parse(cleaned.replace(/'/g, '"')); } catch {}
            
            // Если JSON безнадежно сломан, пробуем вытащить prompt регуляркой
            const promptMatch = cleaned.match(/"prompt"\s*:\s*"((?:\\"|[^"])*)"/i) || cleaned.match(/"description"\s*:\s*"((?:\\"|[^"])*)"/i);
            if (promptMatch) return { prompt: promptMatch[1] };
            
            return { prompt: cleaned }; // В крайнем случае используем всё содержимое как промпт
        };

        // Основной случай — именно то, что просим у модели: одинарная кавычка снаружи,
        // двойные внутри JSON (см. промпт про строгий формат). Захват ЖАДНЫЙ ([\s\S]*),
        // а не ленивый: промпт — обычная английская проза и почти всегда содержит
        // апострофы («character's», «don't»). Ленивый захват останавливался на ПЕРВОМ
        // таком апострофе, приняв его за закрывающую кавычку — промпт обрезался
        // посреди слова, а хвост сырого тега оставался видимым текстом в посте.
        // Жадный ищет ПОСЛЕДНЮЮ одинарную кавычку перед закрывающим '>' тега, а внутри
        // JSON с двойными кавычками одиночный апостроф больше ни с чем не спутать.
        let tagMatch = source.match(/<img\b[^>]*?data-iig-instruction\s*=\s*\\?'([\s\S]*)\\?'[^>]*>/i);

        // Запасной случай — модель перепутала и обернула двойными кавычками. Тут жадность
        // уже опасна: внутри самого тега рядом лежит src="...", тоже в двойных кавычках,
        // и жадный поиск заехал бы в него. Разбор кавычек внутри содержимого — на parseJson.
        if (!tagMatch) {
            tagMatch = source.match(/<img\b[^>]*?data-iig-instruction\s*=\s*\\?"([\s\S]*?)\\?"[^>]*>/i);
        }

        if (tagMatch) {
            const data = parseJson(tagMatch[1]);
            if (data) return { tag: tagMatch[0], data };
        }

        // Старый формат: [IMG:GEN:{...}]
        const start = source.indexOf('[IMG:GEN:');
        if (start !== -1) {
            let depth = 0;
            for (let i = start + 'IMG:GEN:'.length; i < source.length; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') depth--;
                else if (source[i] === ']' && depth <= 0) {
                    const tag = source.slice(start, i + 1);
                    const data = parseJson(tag.slice('[IMG:GEN:'.length, -1));
                    if (data) return { tag, data };
                    break;
                }
            }
        }

        return null;
    }

    /**
     * Переносит описание из тега в поля объекта и вычищает тег из текста:
     * в подписи к посту разметке не место.
     */
    function absorbImageTag(item) {
        if (!item || item.image_prompt) return;
        const found = extractImageTag(item.text);
        if (!found) return;

        const prompt = String(found.data.prompt || found.data.description || '').trim();
        if (prompt) {
            item.image_prompt = prompt;
            // Параметры кадра модель выбирает под конкретное фото — вертикальное
            // селфи и горизонтальный вид требуют разного соотношения сторон
            item.image_opts = {
                style: String(found.data.style || '').trim(),
                aspect_ratio: String(found.data.aspect_ratio || '').trim(),
                image_size: String(found.data.image_size || '').trim(),
            };
        }
        item.text = String(item.text).replace(found.tag, '').replace(/\s{2,}/g, ' ').trim();
    }

    // ─── Отношения (симпатия) ──────────────────────────────────────────────────

    const NOVA_RELATIONSHIP_DEFAULTS = {
        // Хэндлы (без @), за кем следим — остальные ИИ вообще не просят отчитываться
        tracked: [],
        // handle -> { affinity: 0-100, status: '', reactions: [{text, delta, time}] }
        data: {},
        // Сколько смен статуса накопилось с последнего открытия вкладки — бейдж
        // на иконке в шапке, как непрочитанные ЛС, вместо всплывающих тостов
        unreadCount: 0,
    };

    // Запасной статус — на случай, если модель не прислала свою формулировку
    // (поле "status" в теге опционально). Вычисляем из накопленной симпатии, а не
    // придумываем на лету: иначе одна и та же цифра получала бы разные ярлыки от
    // раза к разу. Цвета — нежные, но нарочно ДАЛЕКО от --nova-accent (#1da1f2):
    // прежняя голубая «Друзья» сливалась с акцентным цветом интерфейса, и смена
    // цвета полоски была незаметна на глаз.
    // Темы оформления ЛС-чата. Красят ВЕСЬ экран переписки, а не только пузыри:
    // значения уходят CSS-переменными на #nova-view-single-dm (см. applyDMThemeVars),
    // а шапка, поле ввода, карточки-уведомления, переводы и прочее читают их с
    // фолбэком на обычные цвета NOVA — поэтому тема 'default' просто ничего не
    // задаёт и всё выглядит как раньше.
    // background используется только когда у треда НЕТ своей картинки-обоев —
    // загруженная картинка всегда в приоритете.
    const NOVA_DM_THEMES = [
        {
            id: 'default', name: 'Обычная', background: null, vars: null,
            userBubble: null, otherBubble: null,
        },
        {
            id: 'love', name: 'Романтика',
            background: 'linear-gradient(160deg, #2a1520 0%, #3d1d2e 55%, #241019 100%)',
            userBubble: '#a8355f', otherBubble: '#3a2130',
            vars: {
                'user-bubble': '#a8355f', 'user-text': '#ffffff',
                'other-bubble': '#3a2130', 'other-text': '#f5e3ea',
                surface: '#1e0f18', card: '#33202c',
                'card-text': '#f5e3ea', accent: '#e0729c',
                text: '#f7e9ef', muted: '#c9a3b5', border: '#59374a',
            },
        },
        {
            id: 'midnight', name: 'Полночь',
            background: 'linear-gradient(160deg, #0f2027 0%, #203a43 55%, #16242b 100%)',
            userBubble: '#2f5d8a', otherBubble: '#1d2f38',
            vars: {
                'user-bubble': '#2f5d8a', 'user-text': '#ffffff',
                'other-bubble': '#1d2f38', 'other-text': '#dce8ef',
                surface: '#0c1a20', card: '#1a2c35',
                'card-text': '#dce8ef', accent: '#6fa8dc',
                text: '#e8eef2', muted: '#93a9b5', border: '#2f4a58',
            },
        },
        {
            id: 'forest', name: 'Лес',
            background: 'linear-gradient(160deg, #282b22 0%, #1b1c18 60%, #131410 100%)',
            userBubble: '#59654a', otherBubble: '#1b1c18',
            vars: {
                'user-bubble': '#59654a', 'user-text': '#eaeee4',
                'other-bubble': '#1b1c18', 'other-text': '#e3e8de',
                surface: '#131410', card: '#282b22',
                'card-text': '#e3e8de', accent: '#a9bd9d',
                text: '#e3e8de', muted: '#a3b391', border: '#6d7c58',
            },
        },
        {
            id: 'sunset', name: 'Закат',
            background: 'linear-gradient(160deg, #2b1220 0%, #6b2f3d 55%, #94472f 100%)',
            userBubble: '#b04a5f', otherBubble: '#33202a',
            vars: {
                'user-bubble': '#b04a5f', 'user-text': '#ffffff',
                'other-bubble': '#33202a', 'other-text': '#f7e6dd',
                surface: '#24121c', card: '#3a2430',
                'card-text': '#f7e6dd', accent: '#ff8f6b',
                text: '#fdeee6', muted: '#d3ab9c', border: '#5c3341',
            },
        },
    ];

    // Полный список ключей — чтобы при смене темы гарантированно снять переменные
    // прошлой, а не оставить их подмешанными в новую
    const NOVA_DM_THEME_VAR_KEYS = [
        'user-bubble', 'user-text', 'other-bubble', 'other-text',
        'surface', 'card', 'card-text', 'accent', 'text', 'muted', 'border',
    ];

    function getDMTheme(id) {
        return NOVA_DM_THEMES.find(t => t.id === id) || NOVA_DM_THEMES[0];
    }

    /**
     * Прокидывает цвета темы CSS-переменными на весь экран переписки.
     * Переменные ставим ещё и на #nova-backdrop: модалка подтверждения и меню
     * долгого нажатия рендерятся именно туда, ВНЕ окна переписки, и иначе
     * остались бы непрокрашенными дырами в теме. Из-за этого же их обязательно
     * надо снимать при выходе из переписки (см. clearDMThemeVars) — иначе тема
     * протекла бы на подтверждения в ленте и других вкладках.
     */
    function applyDMThemeVars(theme) {
        [document.getElementById('nova-view-single-dm'), document.getElementById('nova-backdrop')]
            .filter(Boolean)
            .forEach(el => {
                NOVA_DM_THEME_VAR_KEYS.forEach(key => {
                    const value = theme.vars?.[key];
                    if (value) el.style.setProperty(`--nova-dm-${key}`, value);
                    else el.style.removeProperty(`--nova-dm-${key}`);
                });
                el.classList.toggle('nova-dm-themed', !!theme.vars);
            });
    }

    function clearDMThemeVars() {
        applyDMThemeVars(getDMTheme('default'));
    }

    const NOVA_RELATIONSHIP_BUCKETS = [
        { min: 0, label: 'Враждебность', color: '#e0888f' },
        { min: 20, label: 'Неприязнь', color: '#e0aa82' },
        { min: 40, label: 'Нейтралитет', color: '#a3a8b5' },
        { min: 60, label: 'Приятели', color: '#8ecf9e' },
        { min: 80, label: 'Друзья', color: '#f0c675' },
        { min: 95, label: 'Близкие друзья', color: '#e08ecf' },
    ];

    function relationshipBucketForAffinity(affinity) {
        let bucket = NOVA_RELATIONSHIP_BUCKETS[0];
        for (const b of NOVA_RELATIONSHIP_BUCKETS) {
            if (affinity >= b.min) bucket = b;
            else break;
        }
        return bucket;
    }

    function relationshipStatusForAffinity(affinity) {
        return relationshipBucketForAffinity(affinity).label;
    }

    function relationshipColorForAffinity(affinity) {
        return relationshipBucketForAffinity(affinity).color;
    }

    /**
     * Симпатия и её сдвиги теперь могут быть дробными (0.5, -1.5 — см. промпт),
     * а не только целыми — округляем показ до одного знака после запятой (не
     * больше, иначе вылезет "67.30000000000001%" из повторных +0.1/-0.1) и
     * запятая вместо точки — той же локали, что уже используют деньги
     * (formatMoney), а не голая JS-точка посреди русского интерфейса.
     */
    function formatAffinity(n) {
        return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    }

    /** Тот же chatId, каким уже ключуются chatFeeds — берётся отсюда же, чтобы не разъехаться. */
    function getCurrentChatId() {
        if (typeof window.chatId !== 'undefined') return window.chatId;
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        return stContext?.chatId || 'default';
    }

    function getRelationshipSettings() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return structuredClone(NOVA_RELATIONSHIP_DEFAULTS);
        if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};

        const store = ctx.extensionSettings.NOVA;
        if (!store.relationshipsByChat || typeof store.relationshipsByChat !== 'object') {
            store.relationshipsByChat = {};
        }
        // Миграция: раньше отношения были ОДНИ на все чаты сразу — своего chatId
        // у них не было в принципе. Переносим в тот чат, что открыт прямо сейчас,
        // раз другого способа понять, к какой ролке они относились, нет
        if (store.relationships && typeof store.relationships === 'object'
            && Object.keys(store.relationshipsByChat).length === 0) {
            store.relationshipsByChat[getCurrentChatId()] = store.relationships;
            delete store.relationships;
        }

        const chatId = getCurrentChatId();
        if (!store.relationshipsByChat[chatId] || typeof store.relationshipsByChat[chatId] !== 'object') {
            store.relationshipsByChat[chatId] = structuredClone(NOVA_RELATIONSHIP_DEFAULTS);
        }
        const rel = store.relationshipsByChat[chatId];
        if (!Array.isArray(rel.tracked)) rel.tracked = [];
        if (!rel.data || typeof rel.data !== 'object') rel.data = {};
        if (typeof rel.unreadCount !== 'number') rel.unreadCount = 0;
        return rel;
    }

    function saveRelationshipSettings() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        ctx?.saveSettingsDebounced?.();
    }

    function isTrackedHandle(handle) {
        const rel = getRelationshipSettings();
        return rel.tracked.includes(normHandle(handle));
    }

    function getRelationshipRecord(handle) {
        const rel = getRelationshipSettings();
        const key = normHandle(handle);
        if (!rel.data[key]) rel.data[key] = { affinity: 50, status: '', reactions: [], tier: 0 };
        const rec = rel.data[key];
        if (typeof rec.status !== 'string') rec.status = '';
        if (!Array.isArray(rec.reactions)) rec.reactions = [];
        // Уровень сверх шкалы 0-100 — растёт, пока продолжают копиться положительные
        // события уже на самом верху (100%), и падает симметрично на самом дне (0%).
        // Число само по себе там больше не двигается, а прогресс — реальный, не
        // косметика — должен куда-то деваться.
        if (typeof rec.tier !== 'number') rec.tier = 0;
        return rec;
    }

    /** Готовый блок инструкций про симпатию для промпта — пустая строка, если некого отслеживать. */
    function buildRelationshipInstruction(userHandle, target = 'feed') {
        const rel = getRelationshipSettings();
        if (!rel.tracked.length) return '';
        // Для тех, у кого ещё нет ни одной записи, отдельно просим не начинать с
        // нейтральных 50%, а прикинуть текущее состояние отношений по всей
        // истории РП — иначе давние друзья по сюжету стартуют как незнакомцы
        const newHandles = rel.tracked.filter(h => !rel.data[h]?.reactions?.length);
        return NovaPrompts.relationshipInstructionBlock({
            trackedHandles: rel.tracked.map(h => `@${h}`).join(', '),
            newHandles: newHandles.map(h => `@${h}`).join(', '),
            userHandle,
            target,
        });
    }

    // Достаёт JSON-объект из тега вида <span data-XXX='{...}'> — общий разбор для
    // всех наших span-тегов (симпатия, музыка, решение про аватар). Закрывающий
    // </span> необязателен (модель сплошь и рядом не закрывает тег, особенно когда
    // следом вплотную идёт ещё один такой же). Раньше искали регэкспом закрывающую
    // одинарную кавычку — но названия треков сплошь и рядом содержат апострофы
    // ("I'm Drowning"), которые ломали и ленивый поиск (обрывался на первом же
    // апострофе внутри JSON), и жадный (проглатывал соседний тег целиком, если тот
    // идёт следом без </span> между ними). Вместо этого просто считаем скобки самого
    // JSON, как extractBalancedJson — тогда апостроф внутри строки ничего не значит,
    // останавливаемся ровно на СВОЕЙ закрывающей `}`.
    /**
     * Разбирает JSON из тега С УЧЁТОМ экранирования кавычек — но БЕЗ какой-либо
     * нормализации входа. Легитимно экранированная кавычка внутри значения
     * (название трека вроде The Weeknd - "Save Your Tears", реплика с цитатой
     * в reaction/note) после одного прохода JSON.parse внешнего конверта доходит
     * сюда как настоящая пара backslash+quote (\") — и это НОРМАЛЬНЫЙ, корректный
     * escape, сканер ниже обязан читать его как "экранированная кавычка, остаёмся
     * в строке", а не резать заранее.
     */
    function scanSpanTagJsonOnce(source, attrName) {
        const attrRe = new RegExp(`<span\\b[^>]*?${attrName}\\s*=\\s*\\\\?['"]`, 'i');
        const startMatch = source.match(attrRe);
        if (!startMatch) return null;

        const tagStart = startMatch.index;
        const jsonStart = startMatch.index + startMatch[0].length;
        if (source[jsonStart] !== '{') return null;

        let depth = 0;
        let inString = false;
        let escaped = false;
        let jsonEnd = -1;
        for (let i = jsonStart; i < source.length; i++) {
            const ch = source[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { if (inString) escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { jsonEnd = i + 1; break; }
            }
        }
        if (jsonEnd === -1) return null;

        // После JSON — закрывающая кавычка атрибута, что угодно до '>', опционально </span>
        const restMatch = source.slice(jsonEnd).match(/^\\?['"][^>]*>(?:\s*<\/span>)?/i);
        if (!restMatch) return null;

        return { tag: source.slice(tagStart, jsonEnd + restMatch[0].length), json: source.slice(jsonStart, jsonEnd), source };
    }

    /**
     * Достаёт JSON-тег из текста, устойчиво к двум РАЗНЫМ вещам, которые обе
     * выглядят как "backslash перед кавычкой" и которые нельзя лечить одним и тем
     * же способом:
     *
     * 1. Легитимный escape — кавычка внутри ДАННЫХ (название трека, заметка,
     *    реплика с цитатой). Сканер обязан прочитать её как есть, ничего не трогая.
     * 2. Модель переэкранировала ГРАНИЦЫ самого тега (пишет \\" вместо \" —
     *    перебарщивает с "экранируй кавычки" из промпта). Тут, наоборот, лишний
     *    backslash нужно снять, иначе подсчёт кавычек/скобок съезжает.
     *
     * Раньше нормализация \+" -> " применялась вслепую ко ВСЕМУ источнику перед
     * сканированием — чинила случай 2, но заодно разрушала случай 1: превращала
     * "Save Your Tears\" в оборванную строку, и извлечение падало на любом
     * треке/реплике с кавычкой внутри (баг, не редкий — ровно про это жаловались
     * на отправку музыки). Теперь сначала пробуем БЕЗ нормализации — она не портит
     * случай 1 и успешно разбирает подавляющее большинство тегов, включая случай 1.
     * Только если результата нет или он не парсится (значит, скорее всего, случай 2)
     * — пересканируем с нормализацией всего источника целиком.
     */
    function extractSpanTagJson(source, attrName) {
        const plain = scanSpanTagJsonOnce(source, attrName);
        if (plain && parseTagJson(plain.json)) return plain;

        // source отдаём нормализованным — вызывающий код режет/сравнивает tag
        // именно относительно НЕГО, а не исходного item.text: при переэкранировании
        // они больше не совпадают посимвольно.
        return scanSpanTagJsonOnce(source.replace(/\\+"/g, '"'), attrName);
    }

    /**
     * Общий разбор JSON, найденного extractSpanTagJson — та же логика "как есть,
     * потом с нормализацией", но теперь уже на уровне самого JSON.parse, а не
     * поиска границ. Нужна отдельно от extractSpanTagJson, потому что тег может
     * быть найден корректно, но всё равно не распарситься с первой попытки —
     * см. комментарий там же.
     */
    function parseTagJson(json) {
        const plain = json.replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        try { return JSON.parse(plain); } catch {}
        try { return JSON.parse(plain.replace(/'/g, '"')); } catch {}

        const normalized = json.replace(/\\+"/g, '"').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        try { return JSON.parse(normalized); } catch {}
        try { return JSON.parse(normalized.replace(/'/g, '"')); } catch {}
        return null;
    }

    /**
     * Вытаскивает из текста тег про сдвиг симпатии — тот же формат, что и у фото:
     *   <span data-nova-relationship='{"affinity_delta":3,"reaction":"..."}'></span>
     */
    function extractRelationshipTag(text) {
        const source = String(text || '');
        if (!source.includes('data-nova-relationship')) return null;

        const found = extractSpanTagJson(source, 'data-nova-relationship');
        if (!found) return null;

        // См. parseTagJson: сперва как есть (не портит легитимные кавычки внутри
        // reaction), нормализация переэкранирования — только запасным вариантом.
        const data = parseTagJson(found.json);
        if (!data) return null;
        return { tag: found.tag, data, source: found.source };
    }

    /**
     * Переносит сдвиг симпатии и реакцию из тега в сохранённые данные персонажа,
     * вычищает тег из текста. Тег вырезаем ВСЕГДА, даже если хэндл сейчас не
     * отслеживается — модель могла ошибиться адресатом, а сырая разметка в посте
     * недопустима в любом случае (см. тот же принцип у absorbImageTag).
     */
    function absorbRelationshipTag(item) {
        if (!item) return;
        const handle = item.handle || item.sender_handle || item.author_handle;
        const found = extractRelationshipTag(item.text);
        if (!found) return;

        // Режем относительно found.source (нормализованная копия), а не сырого
        // item.text — при переэкранировании тега они расходятся посимвольно,
        // и .replace(found.tag, '') на исходном тексте молча ничего не находил.
        item.text = String(found.source).replace(found.tag, '').replace(/\s{2,}/g, ' ').trim();
        if (!handle || !isTrackedHandle(handle)) return;

        // До одного знака после запятой — модели разрешено присылать дробные сдвиги
        // (0.5, -1.5) для "чуть-чуть, но не совсем ничего", не только целые. Округляем
        // до 0.1, а не оставляем как есть, — иначе рано или поздно придёт что-то вроде
        // 0.30000000004 из-за собственной арифметики модели, и это осядет в истории.
        const rawDelta = Number(found.data.affinity_delta);
        const delta = Number.isFinite(rawDelta) ? Math.max(-10, Math.min(10, Math.round(rawDelta * 10) / 10)) : 0;
        const reaction = String(found.data.reaction || '').trim();
        const status = String(found.data.status || '').trim();
        const rawEstimate = found.data.affinity_estimate;
        const hasEstimate = rawEstimate !== undefined && rawEstimate !== null && rawEstimate !== '' && Number.isFinite(Number(rawEstimate));
        const estimate = hasEstimate ? Math.max(0, Math.min(100, Math.round(Number(rawEstimate)))) : null;
        // Нечего запоминать и нечего откатывать — не создаём пустую запись
        if (!reaction && !delta && !status && estimate === null) return;

        const rec = getRelationshipRecord(handle);
        const isFirstEvent = rec.reactions.length === 0;
        // Значение ДО этого события целиком — не только дельта, а вообще всё, что
        // тут может произойти (в т.ч. стартовая оценка ниже). Нужно, чтобы откат
        // при удалении поста мог восстановить ровно то, что было, а не просто
        // вычесть дельту — та не знает про applied estimate и про клэмп на 0/100,
        // из-за чего откат иначе съезжал (см. revertRelationshipEvent).
        const prevAffinity = rec.affinity;
        const prevTier = rec.tier || 0;
        // Первая оценка для этого героя — берём её за стартовую точку вместо
        // нейтральных 50%, а не молча копим сдвиги поверх произвольного дефолта:
        // давние друзья по сюжету не должны стартовать как незнакомцы
        if (estimate !== null && isFirstEvent) rec.affinity = estimate;
        rec.affinity = Math.max(0, Math.min(100, rec.affinity + delta));
        // Модель присылает статус не всегда — только когда есть что сказать точнее
        // числа. Пока не пришлёт свой, показываем вычисленный из симпатии.
        if (status) rec.status = status;
        // Число упёрлось в потолок/дно и дальше физически не движется — но событие
        // всё равно было настоящим. Продолжающийся рост/падение уходит в уровень:
        // +1 за каждое положительное событие уже на 100%, -1 симметрично на 0%.
        // В отличие от обычной смены статуса (та копится в бейдж на вкладке, без
        // тостов — навязчиво), апгрейд уровня достаточно редкий, чтобы всплывающее
        // уведомление того стоило.
        if (prevAffinity >= 100 && rec.affinity >= 100 && delta > 0) {
            rec.tier = prevTier + 1;
            const name = item.name || item.sender_name || handle;
            toastr.success(`${name}: ур. ${rec.tier}${rec.status ? ' — ' + rec.status : ''}`, '✨ Апгрейд отношений!');
        } else if (prevAffinity <= 0 && rec.affinity <= 0 && delta < 0) {
            rec.tier = prevTier - 1;
            const name = item.name || item.sender_name || handle;
            toastr.warning(`${name}: ур. ${Math.abs(rec.tier)}${rec.status ? ' — ' + rec.status : ''}`, '💔 Кризис отношений');
        }
        if (reaction || delta || (estimate !== null && isFirstEvent)) {
            // id — память об этом конкретном посте/сообщении: если его потом удалят,
            // revertRelationshipsDeep найдёт именно эту запись и откатит именно её
            // (не последнюю по времени, которая могла прийти уже от другого,
            // более свежего поста)
            const eventId = `relev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            rec.reactions.unshift({ id: eventId, text: reaction, delta, prevAffinity, prevTier, time: Date.now() });
            // Запас побольше: запись, вытесненная из истории, разучится откатываться
            // при удалении своего поста — affinity останется применённым навсегда
            rec.reactions = rec.reactions.slice(0, 50);
            item.relationshipEvent = { handle: normHandle(handle), id: eventId };

            // Раньше бейдж копился только при смене статус-бакета (шаг ~20%), а
            // обычные +1/+2 не показывали вообще ничего — снаружи это выглядело как
            // «уведомления пропали», хотя симпатия реально менялась. Тосты на каждое
            // событие были бы навязчивы (см. апгрейд уровня выше), а бейдж — нет.
            const rel = getRelationshipSettings();
            rel.unreadCount = (rel.unreadCount || 0) + 1;
            updateRelationshipBadge();
        }
        saveRelationshipSettings();
    }

    /** Откатывает конкретный сдвиг симпатии по id — используется при удалении поста/сообщения. */
    function revertRelationshipEvent(handle, eventId) {
        if (!handle || !eventId) return;
        const rec = getRelationshipRecord(handle);
        const idx = rec.reactions.findIndex(r => r.id === eventId);
        if (idx === -1) return;
        const [entry] = rec.reactions.splice(idx, 1);
        // Точное значение ДО события — надёжнее, чем «отнять дельту»: та не отменяет
        // применённую стартовую оценку (affinity_estimate) и не переживает клэмп на
        // границах 0/100 (0-5=0, а не -5 — вычитание задним числом даёт не то число).
        // Записи, сохранённые до этого фикса, prevAffinity не имеют — для них
        // старое поведение как запасной вариант.
        rec.affinity = typeof entry.prevAffinity === 'number'
            ? entry.prevAffinity
            : Math.max(0, Math.min(100, rec.affinity - entry.delta));
        if (typeof entry.prevTier === 'number') rec.tier = entry.prevTier;

        // Бейдж на сердечке считает НЕПРОЧИТАННЫЕ события, а откат убирает само
        // событие — счётчик обязан ехать за ним. Без этого перегенерация поста
        // давала два уведомления на одну реакцию: старое событие откатывалось, но
        // его +1 оставался висеть, и новое накидывало сверху ещё один.
        const rel = getRelationshipSettings();
        if (rel.unreadCount > 0) {
            rel.unreadCount--;
            updateRelationshipBadge();
        }
        saveRelationshipSettings();
    }

    /**
     * Память об отношениях привязана к посту/ответу/сообщению, которое её вызвало —
     * удаление ленты или переписки не должно оставлять «призрачный» сдвиг симпатии
     * от того, чего больше нет. Рекурсивно спускается по вложенным replies, поэтому
     * достаточно вызвать один раз на верхний пост или на удаляемое DM-сообщение.
     */
    function revertRelationshipsDeep(item) {
        if (!item) return;
        if (item.relationshipEvent) {
            revertRelationshipEvent(item.relationshipEvent.handle, item.relationshipEvent.id);
        }
        if (Array.isArray(item.replies)) item.replies.forEach(revertRelationshipsDeep);
    }

    /**
     * Удаляем уведомление «вы установили обои» — снимаем сами обои с треда, иначе
     * он остаётся с картинкой, для которой в переписке больше нет ни следа.
     * Сравниваем по картинке, а не просто «есть wallpaperChange»: если обои успели
     * сменить ещё раз позже, удаление СТАРОГО уведомления не должно стирать новые.
     */
    function revertWallpaperIfDeleted(thread, item) {
        if (thread && item?.wallpaperChange && thread.wallpaper === item.wallpaperChange.image) {
            thread.wallpaper = null;
        }
    }

    /** То же самое, но для темы оформления — сравниваем по themeId, та же логика. */
    function revertThemeIfDeleted(thread, item) {
        if (thread && item?.themeChange && (thread.theme || 'default') === item.themeChange.themeId) {
            thread.theme = 'default';
        }
    }

    // ─── MoodTube (музыка) ──────────────────────────────────────────────────────
    // Стороннее расширение, не наше. Интеграция полностью опциональна: если оно не
    // установлено, window.MoodTubeAPI просто не появится, и всё ниже молча выключается —
    // ни настройки, ни промпт не нужны.

    function isMoodTubeAvailable() {
        return typeof window !== 'undefined' && !!window.MoodTubeAPI;
    }

    // Просто просить модель "не повторяться" не работает — без конкретного списка
    // она стабильно скатывается в один и тот же статистически очевидный трек
    // (см. buildMusicInstruction). Храним реально присланные треки и суём их в
    // промпт как список того, что уже прозвучало — переживает перезагрузку страницы.
    function getRecentMusicTracks() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return [];
        if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};
        if (!Array.isArray(ctx.extensionSettings.NOVA.recentTracks)) ctx.extensionSettings.NOVA.recentTracks = [];
        return ctx.extensionSettings.NOVA.recentTracks;
    }

    function recordSharedTracks(tracks) {
        if (!Array.isArray(tracks) || !tracks.length) return;
        const list = getRecentMusicTracks();
        tracks.forEach(raw => {
            const clean = String(raw || '').trim();
            if (!clean) return;
            const dupIdx = list.findIndex(t => t.toLowerCase() === clean.toLowerCase());
            if (dupIdx !== -1) list.splice(dupIdx, 1);
            list.push(clean);
        });
        while (list.length > 25) list.shift();
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        ctx?.saveSettingsDebounced?.();
    }

    /**
     * MoodTube инициализируется через собственный setTimeout и может ещё не успеть
     * выставить window.MoodTubeAPI к моменту вызова — тогда ждём его событие
     * готовности. Если он уже готов, вызываем сразу, без лишнего ожидания события.
     */
    function withMoodTube(cb) {
        if (typeof window === 'undefined') return;
        if (window.MoodTubeAPI) { cb(window.MoodTubeAPI); return; }
        window.addEventListener('moodtube:ready', e => cb(e.detail || window.MoodTubeAPI), { once: true });
    }

    /** Блок про музыку для промпта — пусто, если MoodTube не подключен в этой сессии. */
    function buildMusicInstruction() {
        if (!isMoodTubeAvailable()) return '';
        return NovaPrompts.musicInstructionBlock({ recentTracks: getRecentMusicTracks().join(', ') });
    }

    /** Блок про команду юзера (/фото, /музыка, /плейлист) — пусто, если в этом
     *  заходе никакой команды не было. */
    function buildUserCommandInstruction(command) {
        return NovaPrompts.userCommandInstructionBlock(command);
    }

    /**
     * Вытаскивает из текста тег про присланный трек/плейлист — тот же формат,
     * что и у фото/симпатии: <span data-nova-music='{"tracks":[...]}'></span>
     */
    function extractMusicTag(text) {
        const source = String(text || '');
        if (!source.includes('data-nova-music')) return null;

        const found = extractSpanTagJson(source, 'data-nova-music');
        if (!found) return null;

        // См. parseTagJson: сперва как есть — не портит легитимную кавычку в
        // названии трека или заметке, нормализация переэкранирования — запасным
        // вариантом. Именно тут раньше ломались треки вида The Weeknd - "Save
        // Your Tears": слепая нормализация резала кавычки в самом названии.
        const data = parseTagJson(found.json);
        if (!data) return null;
        return { tag: found.tag, data, source: found.source };
    }

    /**
     * Переносит присланный трек/плейлист в реальную очередь MoodTube и вычищает
     * тег из текста. Тег вырезаем ВСЕГДА, даже если MoodTube сейчас недоступен —
     * та же причина, что у absorbImageTag: сырая разметка не должна остаться в посте.
     */
    function absorbMusicTag(item) {
        if (!item) return;
        const found = extractMusicTag(item.text);
        if (!found) return;

        // См. комментарий в absorbRelationshipTag — режем относительно found.source
        item.text = String(found.source).replace(found.tag, '').replace(/\s{2,}/g, ' ').trim();

        const tracks = Array.isArray(found.data.tracks)
            ? found.data.tracks.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20)
            : [];
        if (!tracks.length) return;

        recordSharedTracks(tracks);

        // playlist_name — необязательное поле: заполнено, когда это именно ИМЕНОВАННЫЙ
        // плейлист (квадратик со списком по клику), а не обычный разовый трек/парочка треков.
        const playlistName = String(found.data.playlist_name || '').trim();

        // Карточка в ленте/переписке — трек НЕ уходит в MoodTube сам по себе, только
        // по нажатию кнопки на самой карточке (playMoodTubeTracksNow). Автопостановка
        // в очередь запускала воспроизведение сама, если MoodTube ничего не играл —
        // ровно то самопроизвольное включение, которого быть не должно.
        item.musicShare = { tracks, note: String(found.data.note || '').trim(), playlistName };
    }

    /**
     * Ручное «▶ Слушать»: первый трек играет НЕМЕДЛЕННО (в обход очереди, через
     * playQuery), остальные из плейлиста — следом обычной очередью. Если у
     * подключённого MoodTube ещё нет playQuery (старая версия без неё),
     * откатываемся на постановку в очередь — не ломаемся молча.
     * @returns {Promise<boolean>} нашёлся ли первый трек
     */
    function playMoodTubeTracksNow(tracks) {
        if (!Array.isArray(tracks) || !tracks.length) return Promise.resolve(false);
        return new Promise(resolve => {
            withMoodTube(async api => {
                const [first, ...rest] = tracks;
                let ok = true;
                try {
                    if (typeof api.playQuery === 'function') {
                        ok = await api.playQuery(first);
                    } else {
                        api.enqueueQuery?.(first);
                    }
                    if (rest.length) {
                        if (typeof api.enqueueMany === 'function') api.enqueueMany(rest);
                        else rest.forEach(t => api.enqueueQuery?.(t));
                    }
                } catch (e) {
                    console.warn('[NOVA] Не удалось запустить трек в MoodTube', e);
                    ok = false;
                }
                resolve(ok);
            });
        });
    }

    // Текущий трек и состояние воспроизведения по данным MoodTube. Трек обновляется
    // событием moodtube:trackchange, состояние — moodtube:statechange (ловит и кнопки
    // в самом виджете MoodTube, и YouTube/Spotify колбэки, не только наши команды).
    // Разово подтягиваются при открытии панели через getCurrentTrack()/isPlaying(),
    // на случай если музыка уже играла до того, как открыли NOVA.
    let moodTubeNowPlaying = null;
    let moodTubeIsPlaying = false;
    // Крестик на плашке прячет её (и ставит на паузу) без остановки самого MoodTube
    // насовсем — как только придёт следующий трек, плашка сама вернётся.
    let moodTubeBarDismissed = false;
    // Приходит раз в секунду тиком MoodTube (moodtube:progress) — своего опроса нет,
    // поэтому на паузе просто перестаёт обновляться и застывает на последнем значении
    // (для YouTube/audio; у Spotify так же — там это реальная позиция плеера, а не
    // наш расчёт). moodTubeSeeking подавляет перезапись во время перетаскивания пальцем.
    let moodTubeProgress = { currentTime: 0, duration: 0 };
    let moodTubeSeeking = false;
    // Плашку показываем ТОЛЬКО когда воспроизведение реально подтверждено в этой
    // сессии. После перезагрузки страницы MoodTube восстанавливает очередь из
    // localStorage, поэтому getCurrentTrack() возвращает трек и isPlaying() может
    // соврать true — хотя звука нет и никто ничего не включал. Событие trackchange
    // шлётся только из настоящего playTrack(), а не из restoreQueueCache, так что
    // оно (или живой тик прогресса) — единственное надёжное доказательство.
    let moodTubePlaybackConfirmed = false;
    // Не все сборки MoodTube шлют moodtube:progress и moodtube:statechange (в одной
    // из версий они пропали, остались только ready/trackchange). Пока прогресс реально
    // не приходил — прячем полоску времени вместо того, чтобы врать «0:00 / 0:00»,
    // а состояние play/pause добираем опросом isPlaying() (см. startMoodTubeStatePoll).
    let moodTubeHasProgressEvents = false;

    function formatMoodTubeTime(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function renderMoodTubeProgress() {
        // Полоска и время есть только если MoodTube реально шлёт moodtube:progress —
        // иначе честнее не показывать её вовсе, чем держать вечные «0:00 / 0:00».
        // Классом, а не .toggle(): у полоски на карточках свои правила показа в CSS,
        // инлайновый display их бы перебил.
        document.body.classList.toggle('nova-mt-no-progress', !moodTubeHasProgressEvents);
        if (!moodTubeHasProgressEvents || moodTubeSeeking) return;
        const { currentTime, duration } = moodTubeProgress;
        $('#nova-mt-time-current').text(formatMoodTubeTime(currentTime));
        $('#nova-mt-time-total').text(formatMoodTubeTime(duration));
        const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
        $('#nova-mt-progress-fill').css('width', pct + '%');
    }

    function renderMoodTubeNowPlaying() {
        const $bar = $('#nova-now-playing');
        if (!$bar.length) return;
        if (moodTubeNowPlaying && moodTubeNowPlaying.title && moodTubePlaybackConfirmed && !moodTubeBarDismissed) {
            $('#nova-now-playing-title').text(moodTubeNowPlaying.title);
            $('#nova-mt-playpause').attr('class', `fa-solid ${moodTubeIsPlaying ? 'fa-pause' : 'fa-play'}`);
            $bar.css('display', 'flex');
            renderMoodTubeProgress();
        } else {
            $bar.hide();
        }
        syncMusicCardsUI();
    }

    // Проверка «это именно этот трек сейчас играет в MoodTube» — по вхождению
    // запроса в реальный найденный заголовок (они редко совпадают дословно:
    // мы шлём "Artist - Title", MoodTube находит "Artist - Title (Official Video)").
    function musicShareIsNowPlaying(tracks) {
        // Без подтверждённого воспроизведения название трека — просто остаток
        // восстановленной очереди MoodTube, карточку по нему подсвечивать нельзя
        if (!moodTubePlaybackConfirmed) return false;
        if (!moodTubeNowPlaying?.title || !Array.isArray(tracks)) return false;
        const now = String(moodTubeNowPlaying.title).toLowerCase();
        return tracks.some(t => {
            const q = String(t).toLowerCase().trim();
            return q && (now.includes(q) || q.includes(now));
        });
    }

    // Разметка одной карточки-трека — переиспользуется и для обычного разового
    // шаринга, и для каждой строки внутри модалки плейлиста (там просто по одному
    // треку на карточку). Кнопка — живой плей/пауза: если это именно тот трек, что
    // сейчас играет в MoodTube, жмак ставит на паузу/снимает с неё, иначе — запускает
    // немедленно. syncMusicCardsUI подхватывает ВСЕ такие карточки одинаково, включая
    // те, что внутри модалки — отдельного кода под неё не нужно.
    function renderTrackCardMarkup(tracks, note) {
        const isNowPlaying = moodTubeIsPlaying && musicShareIsNowPlaying(tracks);
        const curText = isNowPlaying ? formatMoodTubeTime(moodTubeProgress.currentTime) : '0:00';
        const totText = isNowPlaying ? formatMoodTubeTime(moodTubeProgress.duration) : '0:00';
        const pct = isNowPlaying && moodTubeProgress.duration > 0
            ? Math.min(100, (moodTubeProgress.currentTime / moodTubeProgress.duration) * 100)
            : 0;
        return `
            <div class="nova-music-card ${isNowPlaying ? 'playing' : ''}" data-tracks="${escapeHtml(JSON.stringify(tracks))}">
                <div class="nova-music-play" title="Слушать через MoodTube">
                    <i class="fa-solid ${isNowPlaying ? 'fa-pause' : 'fa-play'}"></i>
                </div>
                <div class="nova-music-info">
                    ${tracks.map(t => `<div class="nova-music-track">${escapeHtml(t)}</div>`).join('')}
                    ${note ? `<div class="nova-music-note">${escapeHtml(note)}</div>` : ''}
                    <div class="nova-music-progress-row">
                        <span class="nova-mt-time nova-mt-time-current">${curText}</span>
                        <div class="nova-mt-progress-track"><div class="nova-mt-progress-fill" style="width:${pct}%"></div></div>
                        <span class="nova-mt-time nova-mt-time-total">${totText}</span>
                    </div>
                </div>
            </div>
        `;
    }

    // Именованный плейлист (5-20 треков) — квадратная плитка вместо широкой карточки;
    // список открывается модалкой по клику (см. openPlaylistModal/bindMusicShareEvents).
    function renderPlaylistTile(share) {
        return `
            <div class="nova-playlist-tile" data-tracks="${escapeHtml(JSON.stringify(share.tracks))}" data-playlist-name="${escapeHtml(share.playlistName)}">
                <i class="fa-solid fa-record-vinyl"></i>
                <div class="nova-playlist-tile-info">
                    <div class="nova-playlist-tile-name">${escapeHtml(share.playlistName)}</div>
                    <div class="nova-playlist-tile-count">${share.tracks.length} ${share.tracks.length === 1 ? 'трек' : 'треков'}</div>
                </div>
            </div>
        `;
    }

    // Карточка присланного трека/плейлиста — рисуется рядом с текстом поста/сообщения,
    // как и прикреплённая картинка. Именованный плейлист (playlistName заполнен) идёт
    // плиткой с модалкой, разовый трек/пара треков — обычной карточкой.
    function renderMusicShare(item) {
        const share = item?.musicShare;
        if (!share || !Array.isArray(share.tracks) || !share.tracks.length) return '';
        if (share.playlistName) return renderPlaylistTile(share);
        return renderTrackCardMarkup(share.tracks, String(share.note || '').trim());
    }

    // Модалка со списком плейлиста — открывается по клику на плитку. Каждая строка —
    // своя мини-карточка-трек (renderTrackCardMarkup с массивом из одного элемента),
    // плюс кнопка "Включить всё" сверху, которая через playMoodTubeTracksNow играет
    // первый трек немедленно и ставит остальные следом в очередь.
    function openPlaylistModal(name, tracks) {
        $('#nova-playlist-modal-overlay').remove();
        const rows = tracks.map(t => renderTrackCardMarkup([t], '')).join('');
        const html = `
            <div id="nova-playlist-modal-overlay" class="nova-folder-overlay active" style="z-index: 9999; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.6);">
                <div class="nova-playlist-modal">
                    <div class="nova-playlist-modal-header">
                        <div class="nova-playlist-modal-title">${escapeHtml(name)}</div>
                        <i class="fa-solid fa-xmark nova-playlist-modal-close"></i>
                    </div>
                    <button class="nova-playlist-play-all" data-tracks="${escapeHtml(JSON.stringify(tracks))}">
                        <i class="fa-solid fa-play"></i> Включить всё
                    </button>
                    <div class="nova-playlist-modal-list">${rows}</div>
                </div>
            </div>
        `;
        $('#nova-backdrop').append(html);
        syncMusicCardsUI();
    }

    // Живая перерисовка уже отрендеренных карточек трека — вызывается при любом
    // изменении статуса воспроизведения (события MoodTube, наши же клики), чтобы
    // карточки в открытом чате не расходились с реальным состоянием плеера.
    function syncMusicCardsUI() {
        $('.nova-music-card').each(function () {
            const $card = $(this);
            if ($card.data('busy')) return;
            let tracks = [];
            try { tracks = JSON.parse($card.attr('data-tracks') || '[]'); } catch {}
            const isNowPlaying = moodTubeIsPlaying && musicShareIsNowPlaying(tracks);
            $card.toggleClass('playing', isNowPlaying);
            $card.find('.nova-music-play i')
                .toggleClass('fa-pause', isNowPlaying)
                .toggleClass('fa-play', !isNowPlaying);
            if (isNowPlaying && !moodTubeSeeking) {
                $card.find('.nova-mt-time-current').text(formatMoodTubeTime(moodTubeProgress.currentTime));
                $card.find('.nova-mt-time-total').text(formatMoodTubeTime(moodTubeProgress.duration));
                const pct = moodTubeProgress.duration > 0
                    ? Math.min(100, (moodTubeProgress.currentTime / moodTubeProgress.duration) * 100)
                    : 0;
                $card.find('.nova-mt-progress-fill').css('width', pct + '%');
            }
        });
    }

    function bindMusicShareEvents() {
        $(document).on('click', '.nova-playlist-tile', function() {
            let tracks = [];
            try { tracks = JSON.parse($(this).attr('data-tracks') || '[]'); } catch {}
            if (!tracks.length) return;
            openPlaylistModal($(this).attr('data-playlist-name') || 'Плейлист', tracks);
        });
        $(document).on('click', '.nova-playlist-modal-close', function() {
            $('#nova-playlist-modal-overlay').remove();
        });
        $(document).on('click', '#nova-playlist-modal-overlay', function(e) {
            if (e.target === this) $(this).remove();
        });
        $(document).on('click', '.nova-playlist-play-all', async function(e) {
            e.stopPropagation();
            const $btn = $(this);
            if ($btn.data('busy')) return;
            let tracks = [];
            try { tracks = JSON.parse($btn.attr('data-tracks') || '[]'); } catch {}
            if (!tracks.length) return;

            if (!isMoodTubeAvailable()) {
                toastr.warning('MoodTube не найден на странице — расширение не установлено или ещё не загрузилось.');
                return;
            }

            $btn.data('busy', true);
            const $icon = $btn.find('i').removeClass('fa-play').addClass('fa-spinner fa-spin');
            const ok = await playMoodTubeTracksNow(tracks);
            $icon.removeClass('fa-spinner fa-spin').addClass('fa-play');
            if (!ok) toastr.warning(`Трек не найден: ${tracks[0]}`);
            $btn.data('busy', false);
        });

        $(document).on('click', '.nova-music-play', async function(e) {
            e.stopPropagation();
            const $btn = $(this);
            const $card = $btn.closest('.nova-music-card');
            if ($card.data('busy')) return;
            let tracks = [];
            try { tracks = JSON.parse($card.attr('data-tracks') || '[]'); } catch {}
            if (!tracks.length) return;

            if (!isMoodTubeAvailable()) {
                toastr.warning('MoodTube не найден на странице — расширение не установлено или ещё не загрузилось.');
                return;
            }

            // Это и есть трек, что сейчас играет, — жмак переключает паузу, а не
            // запускает его заново с начала очереди.
            if (musicShareIsNowPlaying(tracks)) {
                $card.data('busy', true);
                await withMoodTube(async api => {
                    if (typeof api.togglePlayPause === 'function') {
                        moodTubeIsPlaying = await api.togglePlayPause();
                        renderMoodTubeNowPlaying();
                    }
                });
                $card.data('busy', false);
                return;
            }

            $card.data('busy', true);
            const $icon = $btn.find('i').removeClass('fa-play fa-pause').addClass('fa-spinner fa-spin');
            const ok = await playMoodTubeTracksNow(tracks);
            $icon.removeClass('fa-spinner fa-spin');
            if (!ok) {
                $icon.addClass('fa-play');
                toastr.warning(`Трек не найден: ${tracks[0]}`);
            }
            // При успехе иконку и класс .playing доведёт до ума moodtube:trackchange
            // через syncMusicCardsUI — событие придёт чуть позже, когда поиск реально найдётся.
            $card.data('busy', false);
        });

        // Живой статус MoodTube: трек и состояние — из событий, а не наших же команд.
        // statechange ловит и кнопки на самом виджете MoodTube, и колбэки YouTube/Spotify —
        // не только то, что нажали здесь, в NOVA.
        window.addEventListener('moodtube:trackchange', e => {
            moodTubeNowPlaying = e.detail || null;
            moodTubeBarDismissed = false;
            // Настоящий старт воспроизведения — с этого момента плашке можно верить
            moodTubePlaybackConfirmed = true;
            // Новый трек — старый прогресс больше не актуален, ждём первый тик заново.
            moodTubeProgress = { currentTime: 0, duration: 0 };
            renderMoodTubeNowPlaying();
        });
        window.addEventListener('moodtube:statechange', e => {
            moodTubeIsPlaying = !!e.detail?.isPlaying;
            renderMoodTubeNowPlaying();
        });
        window.addEventListener('moodtube:progress', e => {
            // Живой тик — тоже доказательство, что звук реально идёт (страховка на
            // случай, если панель открыли уже посреди играющего трека)
            moodTubePlaybackConfirmed = true;
            moodTubeHasProgressEvents = true;
            if (!e.detail) return;
            moodTubeProgress = {
                currentTime: Number(e.detail.currentTime) || 0,
                duration: Number(e.detail.duration) || 0,
            };
            renderMoodTubeProgress();
            syncMusicCardsUI();
        });

        // Пауза/play возвращает ЗАПРОШЕННОЕ состояние, не подтверждённое — у YouTube и
        // аудио-фолбэка пауза применяется асинхронно через onStateChange. Красим сразу
        // по возврату для отклика, а moodtube:statechange следом поправит, если реальность
        // окажется другой.
        $(document).on('click', '#nova-mt-playpause', async function() {
            if (!isMoodTubeAvailable()) return;
            withMoodTube(async api => {
                if (typeof api.togglePlayPause !== 'function') return;
                try {
                    moodTubeIsPlaying = await api.togglePlayPause();
                    renderMoodTubeNowPlaying();
                } catch (e) {
                    console.warn('[NOVA] Не удалось переключить паузу в MoodTube', e);
                }
            });
        });
        $(document).on('click', '#nova-mt-next', function() {
            if (!isMoodTubeAvailable()) return;
            withMoodTube(api => api.skipNext?.());
        });
        $(document).on('click', '#nova-mt-prev', function() {
            if (!isMoodTubeAvailable()) return;
            withMoodTube(api => api.skipPrev?.());
        });
        $(document).on('click', '#nova-mt-close', function() {
            if (!isMoodTubeAvailable()) { moodTubeBarDismissed = true; renderMoodTubeNowPlaying(); return; }
            withMoodTube(async api => {
                if (moodTubeIsPlaying && typeof api.togglePlayPause === 'function') {
                    moodTubeIsPlaying = await api.togglePlayPause();
                }
                moodTubeBarDismissed = true;
                renderMoodTubeNowPlaying();
            });
        });

        // Перемотка перетаскиванием/тапом по полоске прогресса — .nova-mt-progress-track
        // встречается несколько раз одновременно (шапка + карточка того, что сейчас
        // играет), поэтому запоминаем именно тот DOM-узел, за который потянули, а не
        // фиксированный id. Пока тянешь — заливка следует за пальцем локально
        // (moodTubeSeeking блокирует перезапись тиками), перемотка в MoodTube уходит
        // только по отпусканию.
        let moodTubeSeekTrackEl = null;

        function moodTubeRatioFromEvent(trackEl, evt) {
            if (!trackEl) return null;
            const rect = trackEl.getBoundingClientRect();
            if (!rect.width) return null;
            const clientX = evt.touches?.[0]?.clientX ?? evt.clientX;
            return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        }

        $(document).on('pointerdown', '.nova-mt-progress-track', function(e) {
            if (!moodTubeProgress.duration) return;
            moodTubeSeekTrackEl = this;
            moodTubeSeeking = true;
            const ratio = moodTubeRatioFromEvent(this, e.originalEvent || e);
            if (ratio !== null) $(this).find('.nova-mt-progress-fill').css('width', (ratio * 100) + '%');
        });
        $(document).on('pointermove', function(e) {
            if (!moodTubeSeeking || !moodTubeSeekTrackEl) return;
            const ratio = moodTubeRatioFromEvent(moodTubeSeekTrackEl, e.originalEvent || e);
            if (ratio !== null) $(moodTubeSeekTrackEl).find('.nova-mt-progress-fill').css('width', (ratio * 100) + '%');
        });
        $(document).on('pointerup', function(e) {
            if (!moodTubeSeeking || !moodTubeSeekTrackEl) return;
            moodTubeSeeking = false;
            const trackEl = moodTubeSeekTrackEl;
            moodTubeSeekTrackEl = null;
            const ratio = moodTubeRatioFromEvent(trackEl, e.originalEvent || e);
            if (ratio === null || !moodTubeProgress.duration) { renderMoodTubeProgress(); syncMusicCardsUI(); return; }
            const seconds = ratio * moodTubeProgress.duration;
            moodTubeProgress.currentTime = seconds;
            if (!isMoodTubeAvailable()) return;
            withMoodTube(api => api.seekTo?.(seconds));
        });
    }

    /**
     * Раз в секунду сверяем play/pause с самим MoodTube. Нужно потому, что событие
     * moodtube:statechange есть не во всех сборках: без него иконка застывала в том
     * состоянии, каким её застало открытие панели, и не реагировала ни на паузу в
     * самом виджете, ни на конец трека. Опрос дешёвый (чтение одной переменной) и
     * не мешает событию, когда оно всё-таки приходит — просто ставит то же значение.
     */
    let moodTubePollTimer = null;

    function startMoodTubeStatePoll() {
        if (moodTubePollTimer) return;
        moodTubePollTimer = setInterval(() => {
            if (!isMoodTubeAvailable() || typeof window.MoodTubeAPI.isPlaying !== 'function') return;
            const playing = !!window.MoodTubeAPI.isPlaying();
            if (playing === moodTubeIsPlaying) return;
            moodTubeIsPlaying = playing;
            renderMoodTubeNowPlaying();
        }, 1000);
    }

    /**
     * Плашки с музыкой при закрытой панели никто не видит, а опрос всё равно тикал
     * ежесекундно до конца жизни вкладки. Останавливаем — при следующем открытии
     * состояние всё равно перечитывается разово (см. openNovaPanel).
     */
    function stopMoodTubeStatePoll() {
        if (!moodTubePollTimer) return;
        clearInterval(moodTubePollTimer);
        moodTubePollTimer = null;
    }

    /**
     * Рисует картинку по описанию от модели. Возвращает data URL.
     * Три семейства эндпоинтов: OpenAI-совместимый (/v1/images/generations — DALL-E,
     * FLUX, SD через прокси), Gemini (nano-banana) и Naistera (/api/generate).
     */
    async function generateNovaImage(prompt, profile, references = [], opts = null) {
        let text = String(prompt || '').trim();
        if (!text) throw new Error('Пустое описание картинки');
        if (!profile) throw new Error('Не выбран профиль подключения для картинок');

        const endpoint = String(profile.endpoint || '').trim().replace(/\/+$/, '');
        if (!endpoint) throw new Error(`У профиля «${profile.name}» не заполнен эндпоинт`);
        const apiKey = String(profile.apiKey || '').trim();
        const model = String(profile.model || '').trim();
        if (!model) throw new Error(`У профиля «${profile.name}» не выбрана модель`);

        // Модель может вписать свой "style" в тег под конкретный кадр — тогда он в
        // приоритете. Если поле пустое, принудительно подставляем выбранный в
        // настройках стиль, а не оставляем картинку вовсе без него.
        const styleText = String(opts?.style || getActiveImageStyle()?.style || '').trim();
        if (styleText) text = `[Style: ${styleText}] ${text}`;

        // Кадр (соотношение сторон) выбирает модель под конкретное фото — вертикальное
        // селфи и горизонтальный вид требуют разного, а угадать заранее нельзя.
        // Настройка профиля тут — только запасной вариант, если модель кадр не назвала.
        const aspect = NOVA_ASPECT_RATIOS.includes(opts?.aspect_ratio)
            ? opts.aspect_ratio
            : (NOVA_ASPECT_RATIOS.includes(profile.aspect_ratio) ? profile.aspect_ratio : '1:1');

        // Разрешение (1K/2K/4K) — наоборот, вопрос цены и качества, а не кадра.
        // Настройка профиля здесь ПРИНУДИТЕЛЬНАЯ и перебивает то, что попросила модель —
        // как forceImageSize в sillyimages. Иначе модель то и дело просит 1K, а профиль
        // настроен на 2K впустую.
        const imageSize = ['1K', '2K', '4K'].includes(profile.image_size)
            ? profile.image_size
            : (['1K', '2K', '4K'].includes(opts?.image_size) ? opts.image_size : '1K');

        if (profile.apiType === 'naistera') {
            // Формат naistera.org: свой путь, свой конверт ответа, референсы —
            // готовыми data URL, а не голым base64, как у Gemini
            const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;
            const body = {
                prompt: references.length ? `${NOVA_REF_INSTRUCTION}\n\n${text}` : text,
                aspect_ratio: aspect,
                model,
            };
            if (references.length) {
                body.reference_images = references
                    .slice(0, NOVA_MAX_REFERENCES)
                    .map(b64 => (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`));
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await imageApiErrorText(res));

            const data = await res.json().catch(() => null);
            if (!data?.data_url) throw new Error('Naistera не вернула картинку (нет data_url)');
            return data.data_url;
        }

        if (profile.apiType === 'gemini') {

            // Референсы идут ПЕРЕД текстом: модель должна сначала увидеть лица,
            // а потом прочитать, что с ними делать
            const parts = references
                .slice(0, NOVA_MAX_REFERENCES)
                .map(b64 => ({ inlineData: { mimeType: 'image/jpeg', data: b64 } }));
            parts.push({ text: references.length ? `${NOVA_REF_INSTRUCTION}\n\n${text}` : text });

            const res = await fetch(`${endpoint}/v1beta/models/${model}:generateContent`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    // Прокси перед Gemini ждут ключ именно в этом заголовке
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: {
                        responseModalities: ['TEXT', 'IMAGE'],
                        imageConfig: { aspectRatio: aspect, imageSize },
                    },
                }),
            });
            if (!res.ok) throw new Error(await imageApiErrorText(res));

            const data = await res.json();
            const replyParts = data?.candidates?.[0]?.content?.parts || [];
            for (const part of replyParts) {
                const inline = part.inlineData || part.inline_data;
                if (inline?.data) {
                    return `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`;
                }
            }
            throw new Error('В ответе нет картинки');
        }

        // OpenAI-совместимый: размер выводим из соотношения, выбранного в теге
        const size = aspectToOpenAISize(aspect);
        const res = await fetch(`${endpoint}/v1/images/generations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt: text, n: 1, size, response_format: 'b64_json' }),
        });
        if (!res.ok) throw new Error(await imageApiErrorText(res));

        const data = await res.json();
        const first = (data?.data || [])[0];
        if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
        // Часть провайдеров игнорирует response_format и отдаёт ссылку
        if (first?.url) return first.url;
        throw new Error('В ответе нет картинки');
    }

    /**
     * Текст ошибки от провайдера как есть — свои формулировки тут только мешают.
     * Раньше резалось до 300 символов, но у 429 частенько самое важное (сколько
     * ждать, в чём именно лимит) лежит как раз в хвосте длинного сообщения.
     */
    async function imageApiErrorText(res) {
        let detail = '';
        try {
            const body = await res.text();
            const parsed = tryParseJson(body);
            detail = parsed?.error?.message || parsed?.message || body;
        } catch { /* тело уже прочитано или его нет */ }
        return `${res.status} ${String(detail || res.statusText)}`;
    }

    /**
     * Проходит по свежесозданным постам или сообщениям, у которых модель попросила фото,
     * и дорисовывает их. Бюджет режется здесь, а не в промпте: модель регулярно просит
     * больше, чем разрешено, и без потолка одна генерация ленты стоила бы как десять.
     *
     * @param {Array} items объекты с полем image_prompt; картинка кладётся в item.image
     * @param {(done:number,total:number)=>void} [onProgress]
     */
    /**
     * Кто из items реально получит картинку в этом заходе: с описанием, не заблокирован,
     * в пределах бюджета. Вынесено отдельно, чтобы вызывающий код мог пометить эти же
     * посты «в ожидании» И ПОКАЗАТЬ ИХ до начала генерации — не дожидаясь её конца.
     */
    function getImageGenTargets(items) {
        const budget = getImageBudget();
        if (!budget) return [];
        return (items || [])
            .filter(item => item && !item.image && String(item.image_prompt || '').trim())
            // canAttachPhoto проверяет список ЗАПРЕЩЁННЫХ ПЕРСОНАЖЕЙ — юзера там
            // нет и быть не может (см. команду /фото — sender:'user' с image_prompt
            // в generateDMResponseInner), так что для его собственных сообщений эту
            // проверку просто пропускаем
            .filter(item => item.sender === 'user' || canAttachPhoto(item.handle || item.sender_handle || ''))
            .slice(0, budget);
    }

    async function attachGeneratedImages(items, onProgress = null) {
        const budget = getImageBudget();
        if (!budget) return 0;

        // Сначала разбираем теги: модель может прислать описание и полем, и тегом
        (items || []).forEach(absorbImageTag);

        // Запрещённых отсеиваем ДО обрезки по бюджету: иначе модель тратит
        // единственное разрешённое фото на того, кому нельзя, и не рисуется ничего.
        // Если targets уже пришли готовыми (вызывающий код заранее пометил их
        // imagePending и показал спиннеры), повторная фильтрация того же списка
        // теми же критериями идемпотентна — список не изменится.
        const targets = getImageGenTargets(items);
        if (!targets.length) return 0;

        // На случай если вызвали напрямую, не через generateFeed/DM-путь, и pending
        // ещё не выставлен — спиннер должен появиться до первого await, а не только
        // после того, как отработает первая генерация.
        // Несколько картинок в одной пачке всегда рисуются СТРОГО ПО ОЧЕРЕДИ (цикл
        // ниже — это for...of с await, не Promise.all), но раньше это было не видно:
        // спиннеры на нескольких постах появлялись одновременно и выглядели так,
        // будто оба генерируются разом. imageQueuePos/Total — только для интерфейса,
        // чтобы показать реальный порядок: «генерируется 1/2» и «в очереди 2/2».
        targets.forEach((item, i) => {
            item.imagePending = true;
            delete item.imageFailed;
            item.imageQueuePos = i + 1;
            item.imageQueueTotal = targets.length;
        });

        const profile = getActiveImageProfile();
        let done = 0;

        // Референсы поддерживает только Gemini: у OpenAI-эндпоинта /v1/images/generations
        // картинку в запрос не приложить
        const useRefs = profile.apiType === 'gemini' || profile.apiType === 'naistera';

        for (const item of targets) {
            item.imageQueueActive = true;
            // Отрисовать «генерируется N/T» ДО запроса к провайдеру, а не только
            // после — иначе следующий элемент очереди молчит все секунды ожидания,
            // пока предыдущий не закончится, и непонятно, что вообще происходит.
            if (onProgress) onProgress(done, targets.length, null);
            const prompt = String(item.image_prompt || '').trim();
            try {
                const author = item.handle || item.sender_handle || '';
                const refs = useRefs ? await prepareReferences(matchReferences(author, prompt)) : [];
                const dataUrl = await generateNovaImage(prompt, profile, refs, item.image_opts);
                // Ссылку от провайдера не сохраняем локально: она протухнет через час-другой,
                // а пост останется в ленте навсегда
                const uploaded = dataUrl.startsWith('data:') ? await uploadNovaImageWithThumbnail(dataUrl) : { image: dataUrl, thumbnail: dataUrl };
                item.image = uploaded.image;
                item.thumbnail = uploaded.thumbnail;
                item.imagePrompt = prompt;
                delete item.imagePending;
                delete item.imageQueuePos;
                delete item.imageQueueTotal;
                delete item.imageQueueActive;
                done++;
                // Зовём ПОСЛЕ каждой картинки, а не до неё: вызывающий код перерисовывает
                // ленту этим колбэком, и спиннер должен смениться результатом сразу
                if (onProgress) onProgress(done, targets.length, item);
            } catch (e) {
                console.error('[NOVA] Не удалось сгенерировать картинку', e);
                toastr.error(`Картинка не сгенерирована: ${e.message || e}`, 'NOVA');
                // Промпт сохраняем и для неудачи — без него нечем будет повторить
                // генерацию по кнопке на затычке
                item.imagePrompt = prompt;
                delete item.imageQueuePos;
                delete item.imageQueueTotal;
                delete item.imageQueueActive;
                // Дальше не идём: если провайдер отвалился, остальные попытки только тянут время.
                // Но у оставшихся «в ожидании» постов спиннер не должен крутиться вечно —
                // они получат затычку в блоке ниже.
                break;
            } finally {
                delete item.image_prompt;
            }
        }

        // Всё, что осталось «в ожидании» — не начатое из-за break выше — получает затычку
        // вместо спиннера, который иначе крутился бы до следующей перезагрузки страницы.
        // Промпт для них ещё жив (их итерация цикла так и не наступила) — сохраняем
        // его тоже, чтобы кнопка «Повторить» знала, что генерировать.
        targets.forEach(item => {
            if (item.imagePending) {
                delete item.imagePending;
                delete item.imageQueuePos;
                delete item.imageQueueTotal;
                delete item.imageQueueActive;
                item.imageFailed = true;
                item.imagePrompt = String(item.image_prompt || item.imagePrompt || '').trim();
            }
        });
        if (onProgress) onProgress(done, targets.length, null);

        // Поле-инструкция не должно осесть в сохранённых постах
        (items || []).forEach(item => { if (item) delete item.image_prompt; });
        return done;
    }

    // Ключи модели в настройках Chat Completion — почти везде `${source}_model`
    const SOURCE_MODEL_KEYS = { makersuite: 'google_model' };

    function getSourceModel(ctx, source) {
        if (!source) return '';
        const settings = ctx?.chatCompletionSettings || {};
        return settings[SOURCE_MODEL_KEYS[source] || `${source}_model`] || '';
    }

    /**
     * Поля payload, которые определяют, КУДА и КАК уходит запрос (эндпоинт, регион, режим авторизации,
     * заголовки прокси). Таверна собирает их в createGenerationParameters по chat_completion_source
     * ИЗ ПРЕСЕТА профиля, а не из самого профиля (см. presetToGeneratePayload в custom-request.js).
     * Пресет — это снимок на момент сохранения: если он от другого источника или устарел, часть полей
     * не добавится вовсе, а часть приедет со старыми значениями (классика — vertexai_region us-central1).
     * Поэтому берём их из ЖИВЫХ настроек Chat Completion Таверны и кладём в overridePayload —
     * он мержится последним и перебивает пресет.
     * Ключ — имя поля в payload, значение — имя настройки в chatCompletionSettings (oai_settings).
     */
    const CONNECTION_FIELDS_BY_SOURCE = {
        vertexai: {
            vertexai_auth_mode: 'vertexai_auth_mode',
            vertexai_region: 'vertexai_region',
            vertexai_express_project_id: 'vertexai_express_project_id',
            use_sysprompt: 'use_sysprompt',
        },
        makersuite: { use_sysprompt: 'use_sysprompt' },
        claude: { use_sysprompt: 'use_sysprompt' },
        custom: {
            custom_url: 'custom_url',
            custom_include_body: 'custom_include_body',
            custom_exclude_body: 'custom_exclude_body',
            custom_include_headers: 'custom_include_headers',
        },
        zai: { zai_endpoint: 'zai_endpoint' },
        siliconflow: { siliconflow_endpoint: 'siliconflow_endpoint' },
        azure_openai: {
            azure_base_url: 'azure_base_url',
            azure_deployment_name: 'azure_deployment_name',
            azure_api_version: 'azure_api_version',
        },
        // У OpenRouter имена в payload не совпадают с именами настроек
        openrouter: {
            provider: 'openrouter_providers',
            quantizations: 'openrouter_quantizations',
            allow_fallbacks: 'openrouter_allow_fallbacks',
            middleout: 'openrouter_middleout',
            use_fallback: 'openrouter_use_fallback',
        },
    };

    // В какое поле payload ложится `api-url` профиля. Профиль важнее живой настройки:
    // он переопределяет её осознанно (см. setApiUrlCallback в slash-commands.js).
    const PROFILE_URL_FIELD_BY_SOURCE = {
        custom: 'custom_url',
        vertexai: 'vertexai_region',
        zai: 'zai_endpoint',
        siliconflow: 'siliconflow_endpoint',
    };

    // Регион Vertex и алиасы эндпоинтов — не URL, слэши там резать нельзя
    const URL_LIKE_FIELDS = ['custom_url'];

    /**
     * Приоритет: профиль → живые настройки Таверны → пресет профиля.
     * @returns {Record<string, any>} поля для overridePayload
     */
    function buildConnectionOverrides(ctx, profile, source) {
        const payload = {};
        if (!source) return payload;

        const settings = ctx?.chatCompletionSettings || {};
        const fields = CONNECTION_FIELDS_BY_SOURCE[source] || {};
        for (const [payloadKey, settingKey] of Object.entries(fields)) {
            const value = settings[settingKey];
            if (value === undefined || value === null || value === '') continue;
            payload[payloadKey] = value;
        }

        const profileUrl = profile?.['api-url'];
        const urlField = PROFILE_URL_FIELD_BY_SOURCE[source];
        if (profileUrl && urlField) {
            const trimmed = String(profileUrl).trim();
            payload[urlField] = URL_LIKE_FIELDS.includes(urlField) ? trimmed.replace(/\/+$/, '') : trimmed;
        }

        // Прокси-пресет профиля разруливает сама Таверна (ConnectionManagerRequestService).
        // Но если у профиля прокси нет, из пресета может протечь чужой reverse_proxy — гасим его живым значением.
        if (!profile?.proxy) {
            payload.reverse_proxy = settings.reverse_proxy || '';
            payload.proxy_password = settings.proxy_password || '';
        }

        // Заголовки провайдера хранятся в самом профиле, в настройках Таверны их нет
        const rawHeaders = profile?.['custom-provider-headers'];
        if (rawHeaders) {
            const parsedHeaders = {};
            for (const line of String(rawHeaders).split('\n')) {
                const separatorIdx = line.indexOf(':');
                if (separatorIdx === -1) continue;
                const key = line.slice(0, separatorIdx).trim();
                if (key) parsedHeaders[key] = line.slice(separatorIdx + 1).trim();
            }
            if (Object.keys(parsedHeaders).length > 0) payload.custom_provider_headers = parsedHeaders;
        }

        if (profile?.['prompt-post-processing']) {
            payload.custom_prompt_post_processing = profile['prompt-post-processing'];
        }

        return payload;
    }

    // Словарь Таверны (REASONING_EFFORT в prompt-converters.js) плюс наши 'inherit' и 'disabled'
    const REASONING_EFFORT_VALUES = ['inherit', 'disabled', 'auto', 'min', 'low', 'medium', 'high', 'max'];

    /**
     * Единого значения «выключить рассуждения» в Таверне нет — каждый бэкенд гасит их по-своему.
     * Проверено по src/endpoints/backends/chat-completions.js и src/prompt-converters.js.
     */
    const REASONING_OFF_BY_SOURCE = {
        // calculateGoogleBudgetTokens: 'min' → thinkingBudget 0
        makersuite: 'min',
        vertexai: 'min',
        // calculateClaudeBudgetTokens: 'auto' → null, и блок thinking в запрос вообще не попадает.
        // Любое другое значение включает мышление минимум на 1024 токена.
        claude: 'auto',
        // reasoning.effort = 'none' в связке с reasoning.exclude = true
        openrouter: 'none',
    };

    /**
     * Для остальных источников выключателя нет: OpenAI-моделям ST превратит 'min' в 'minimal'
     * (OPENAI_REASONING_EFFORT_MAP), а Moonshot и Z.AI гасятся одним include_reasoning: false.
     */
    const REASONING_OFF_FALLBACK = 'min';

    function normalizeReasoningEffort(effort) {
        const value = String(effort ?? '').trim();
        if (value === '0') return 'disabled';
        return REASONING_EFFORT_VALUES.includes(value) ? value : NOVA_GEN_DEFAULTS.thinking_budget;
    }

    /**
     * Собирает поля payload для настройки «Рассуждения (Thinking)» — как в ext-blocks:
     * значение уходит СЫРЫМ, без клиентского ремаппинга. Ремаппинг из getReasoningEffort
     * (openai.js) применяется только к настройкам пресета, а наш overridePayload идёт поверх.
     *
     * Ключевой момент: поле должно присутствовать ВСЕГДА. createRequestData в custom-request.js
     * вычищает undefined ДО мержа с пресетом, поэтому «не передать reasoning_effort» означает
     * не «оставить провайдеру по умолчанию», а «взять значение из пресета профиля» —
     * именно поэтому настройка раньше не управляла ничем.
     */
    function buildReasoningPayload(effort, source) {
        const value = normalizeReasoningEffort(effort);

        // «Не вмешиваться» — NOVA не кладёт в payload ни одного поля про рассуждения.
        // Решают пресет профиля и настройки Chat Completion, ровно как до появления этой настройки.
        if (value === 'inherit') return {};

        return {
            reasoning_effort: value === 'disabled'
                ? (REASONING_OFF_BY_SOURCE[source] ?? REASONING_OFF_FALLBACK)
                : value,
            // Сами рассуждения NOVA нигде не показывает, а в ответе они только жгут бюджет токенов
            include_reasoning: false,
        };
    }

    // Профиль соединения по сохранённому id (приоритет) или имени
    function getSelectedConnectionProfile(ctx) {
        const settings = ctx?.extensionSettings?.NOVA || {};
        const profileName = settings.connection_profile || '';
        const profileId = settings.connection_profile_id || '';
        if (!profileName && !profileId) return null;

        const profiles = ctx?.extensionSettings?.connectionManager?.profiles || [];
        const profile = (profileId && profiles.find(p => p.id === profileId))
            || profiles.find(p => p.name === profileName)
            || profiles.find(p => p.id === profileName);

        if (!profile) throw new Error(`Профиль '${profileName || profileId}' не найден. Выберите профиль заново в настройках NOVA.`);

        // Профиль могли переименовать — подтягиваем актуальное имя
        if (profile.name && profile.name !== profileName) {
            ctx.extensionSettings.NOVA.connection_profile = profile.name;
            ctx.saveSettingsDebounced?.();
        }
        return profile;
    }

    const warnedPresetMismatch = new Set();

    /**
     * Таверна собирает payload из пресета профиля, и все настройки конкретного провайдера
     * (custom_include_headers у прокси, vertexai_auth_mode, провайдеры OpenRouter, top_k…)
     * добавляются по полю chat_completion_source ИЗ ПРЕСЕТА, а не из профиля.
     * Пресет от другого источника (или его отсутствие) — и половина payload теряется.
     */
    function warnIfPresetMismatched(ctx, profile, profileName, source) {
        if (warnedPresetMismatch.has(profile.id)) return;
        warnedPresetMismatch.add(profile.id);

        if (!profile.preset) {
            // Silently ignore missing presets to match DreamAlbum behavior
            return;
        }

        const preset = ctx?.getPresetManager?.('openai')?.getCompletionPresetByName?.(profile.preset);
        if (!preset) return;

        if (preset.chat_completion_source && preset.chat_completion_source !== source) {
            // Silently ignore preset mismatches
        }
    }

    /**
     * Главный API дёргается через generateRaw, который не принимает оверрайды payload,
     * поэтому настройку «Рассуждения» временно проставляем прямо в настройки Chat Completion.
     * @returns {() => void} функция отката
     */
    function applyMainApiReasoning(ctx, effort) {
        const settings = ctx?.chatCompletionSettings;
        // Text Completion не умеет reasoning_effort — там настройка неприменима
        if (!settings || ctx.mainApi !== 'openai') return () => {};

        const payload = buildReasoningPayload(effort, settings.chat_completion_source);
        // «Не вмешиваться» — настройки Таверны не трогаем вообще
        if (payload.reasoning_effort === undefined) return () => {};

        const prevEffort = settings.reasoning_effort;
        const prevShowThoughts = settings.show_thoughts;

        // Здесь значение проходит через getReasoningEffort самой Таверны — сырое min/max она разберёт
        settings.reasoning_effort = payload.reasoning_effort;
        settings.show_thoughts = payload.include_reasoning;

        return () => {
            settings.reasoning_effort = prevEffort;
            settings.show_thoughts = prevShowThoughts;
        };
    }

    /**
     * Дописывает пользовательскую инструкцию про размышления в конец промпта.
     * Это единственный рычаг, который работает у ЛЮБОГО провайдера: reasoning_effort и
     * include_reasoning Таверна для custom/прокси-источников наверх не передаёт вовсе.
     * Не гарантия, а просьба — Gemini, Claude и DeepSeek её слушаются, reasoning-модели OpenAI почти нет.
     */
    function withThinkingHint(ctx, promptText) {
        const settings = ctx?.extensionSettings?.NOVA || {};
        const parts = [promptText];

        // Чеклист размышлений имеет смысл только вместе с преднаполнением ответа:
        // иначе модели велят закрыть блок, который она не начинала
        if (settings.thinking_prompt_enabled && getStartReplyWith(ctx)) {
            const plan = String(getGenSetting(ctx, 'thinking_prompt') || '').trim();
            if (plan) parts.push(plan);
        }

        // По умолчанию включено — выключается только явным снятием галки
        if (settings.thinking_hint_enabled !== false) {
            const hint = String(getGenSetting(ctx, 'thinking_hint') || '').trim();
            if (hint) parts.push(hint);
        }

        // В конец: инструкции ближе к концу промпта модели выполняют охотнее
        return parts.join('\n\n');
    }

    /**
     * Текст, которым преднаполняется ответ модели (аналог Start Reply With в Таверне).
     * Модель продолжает с этого места, поэтому в content открывающий тег уже НЕ придёт —
     * это учтено в stripReasoningBlocks.
     */
    function getStartReplyWith(ctx) {
        const own = String(ctx?.extensionSettings?.NOVA?.start_reply_with || '').trim();
        if (own) return own;

        // Своё поле пустое — берём «Начинать ответ с» из Таверны (Advanced Formatting → Разное).
        // Профильная команда /start-reply-with пишет в ту же настройку, так что здесь всегда
        // актуальное значение, а не снимок из профиля.
        return String(ctx?.powerUserSettings?.user_prompt_bias || '').trim();
    }

    // Преднаполнение = последнее assistant-сообщение, с которого модель продолжает.
    // Картинки идут частями content — так их принимают vision-модели через OpenAI-совместимый формат.
    function buildMessages(promptText, startReplyWith, images = []) {
        const content = images.length
            ? [{ type: 'text', text: promptText }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
            : promptText;

        const messages = [{ role: 'user', content }];
        if (startReplyWith) messages.push({ role: 'assistant', content: startReplyWith });
        return messages;
    }

    // Helper: Call AI without system prompts
    async function callAI(rawPromptText, images = []) {
        const visionImages = (Array.isArray(images) ? images : [images]).filter(Boolean);
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const maxTokensSetting = parseInt(getGenSetting(ctx, 'max_tokens')) || 0;
        // 0 = «Авто»: не переопределяем, берём значение из пресета
        const maxTokens = maxTokensSetting > 0 ? maxTokensSetting : undefined;
        const reasoningEffort = getGenSetting(ctx, 'thinking_budget');
        const promptText = withThinkingHint(ctx, rawPromptText);
        const startReplyWith = getStartReplyWith(ctx);
        const profile = getSelectedConnectionProfile(ctx);

        if (!profile) {
            console.log(`[NOVA] Using Tavern main API...`);
            // generateRaw в этой версии ST не умеет картинки — предупреждаем, а не роняем генерацию
            if (visionImages.length) {
                toastr.warning('Изображение не отправлено модели: главный API это не поддерживает. Выберите профиль подключения.', 'NOVA');
            }
            const restoreReasoning = applyMainApiReasoning(ctx, reasoningEffort);
            try {
                const result = await generateRaw({
                    prompt: promptText,
                    systemPrompt: '',
                    quietToLoud: false,
                    instructOverride: true,
                    responseLength: maxTokens ?? null,
                    trimNames: false,
                    prefill: startReplyWith,
                });
                return extractTextFromResponse(result);
            } catch (e) {
                // Тост показывает вызывающий, иначе на каждый сбой всплывало по два уведомления.
                // Текст пробрасываем как есть — контекст (главный API) остаётся в консоли.
                console.error("[NOVA] generateRaw failed (главный API)", e);
                throw new Error(describeApiError(e));
            } finally {
                restoreReasoning();
            }
        }

        const profileName = profile.name || profile.id;
        console.log(`[NOVA] Using Connection Profile: ${profileName}`);

        if (!profile.api) throw new Error(`У профиля '${profileName}' не выбран API.`);

        const apiMap = ctx?.CONNECT_API_MAP?.[profile.api];
        if (!apiMap) throw new Error(`Неизвестный тип API '${profile.api}' в профиле '${profileName}'.`);
        const isChatCompletion = apiMap.selected === 'openai';

        // Не блокируем генерацию — просто предупреждаем о типовых граблях профилей
        if (isChatCompletion) warnIfPresetMismatched(ctx, profile, profileName, apiMap.source);

        // Профиль хранит модель снимком. Если её там нет (профиль сохранён, когда модель не была
        // выбрана, или 'model' в списке исключений), запрос уходит без поля model и провайдер
        // отвечает 422 «model: Field required» — подставляем текущую модель того же источника.
        let model = profile.model;
        if (isChatCompletion && !model) {
            model = getSourceModel(ctx, apiMap.source);
            if (!model) {
                throw new Error(`В профиле «${profileName}» не сохранена модель. Откройте Connection Profiles, выберите модель и пересохраните профиль (Update).`);
            }
            console.warn(`[NOVA] В профиле «${profileName}» нет модели — берём текущую модель источника ${apiMap.source}: ${model}`);
        }

        // Настройки рассуждений применимы только к chat completion
        let overridePayload = isChatCompletion
            ? { model, ...buildReasoningPayload(reasoningEffort, apiMap.source) }
            : {};

        // Настройки подключения — из живых настроек Таверны, а не из снимка в пресете профиля
        if (isChatCompletion) {
            Object.assign(overridePayload, buildConnectionOverrides(ctx, profile, apiMap.source));
        }

        const service = ctx?.ConnectionManagerRequestService;
        if (service && typeof service.sendRequest === 'function' && profile.id) {
            // Единый путь ST: сам разруливает CC/TC, пресет, инструкт-режим, прокси и URL профиля
            let result;
            try {
                result = await service.sendRequest(
                    profile.id,
                    buildMessages(promptText, startReplyWith, visionImages),
                    maxTokens,
                    { stream: false, extractData: true, includePreset: true, includeInstruct: true },
                    overridePayload,
                );
            } catch (e) {
                // ST оборачивает ошибку в 'API request failed' — достаём настоящую причину.
                // Тост показывает вызывающий: раньше он всплывал и здесь, и там — по два на сбой.
                // Профиль и модель пишем в консоль, а не в тост: в тосте должен быть только
                // оригинальный текст ошибки от Таверны/провайдера.
                console.error(`[NOVA] Connection profile request failed: профиль «${profileName}» (${apiMap.source || profile.api} / ${model || '—'})`, e);
                throw new Error(describeApiError(e));
            }
            const text = extractTextFromResponse(result);
            if (!text) throw new Error('Модель вернула пустой ответ. Обычно это фильтр провайдера или слишком маленький лимит токенов.');
            return text;
        }

        // Фолбэк для старых версий SillyTavern без ConnectionManagerRequestService
        if (!isChatCompletion) {
            throw new Error(`Профиль '${profileName}' использует Text Completion, но эта версия SillyTavern не поддерживает такой запрос из расширения. Обновите SillyTavern или выберите Chat Completion профиль.`);
        }

        const generate_data = {
            'messages': buildMessages(promptText, startReplyWith, visionImages),
            'model': model,
            'temperature': 0.8,
            'stream': false,
            'chat_completion_source': apiMap.source || 'openai',
            ...overridePayload,
        };
        if (maxTokens) generate_data['max_tokens'] = maxTokens;
        // Пресета здесь нет вообще — поля подключения уже пришли из overridePayload

        const headers = (typeof ctx.getRequestHeaders === 'function') ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(generate_data),
        });
        const aiResponse = await res.json().catch(() => null);
        if (!res.ok || aiResponse?.error) {
            // Тост здесь не показываем — его покажет вызывающий, иначе их будет два.
            // Текст берём из тела ответа как есть, статус нужен, когда тела нет вообще.
            const msg = aiResponse?.error?.message || res.statusText || `HTTP ${res.status}`;
            throw new Error(msg);
        }
        const text = extractTextFromResponse(aiResponse);
        if (!text) throw new Error('Модель вернула пустой ответ. Обычно это фильтр провайдера или слишком маленький лимит токенов.');
        return text;
    }

    function tryParseJson(str) {
        if (typeof str !== 'string') return null;
        const trimmed = str.trim();
        if (!trimmed) return null;
        try {
            return JSON.parse(trimmed);
        } catch (e) { /* ignore */ }
        try {
            // Висящие запятые перед закрывающей скобкой — частый косяк моделей
            return JSON.parse(trimmed.replace(/,\s*([}\]])/g, '$1'));
        } catch (e) { /* ignore */ }
        return null;
    }

    // Вырезаем первый сбалансированный JSON-объект/массив, игнорируя скобки внутри строк
    function extractBalancedJson(text) {
        const objIdx = text.indexOf('{');
        const arrIdx = text.indexOf('[');
        let openIdx;
        if (objIdx === -1) openIdx = arrIdx;
        else if (arrIdx === -1) openIdx = objIdx;
        else openIdx = Math.min(objIdx, arrIdx);
        if (openIdx === -1) return null;

        const openChar = text[openIdx];
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = openIdx; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { if (inString) escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === openChar) depth++;
            else if (ch === closeChar) {
                depth--;
                if (depth === 0) return text.slice(openIdx, i + 1);
            }
        }
        return null;
    }

    // Модель упёрлась в лимит токенов и оборвала JSON на полуслове: обрезаем до последнего
    // целого элемента и дозакрываем скобки, чтобы не терять всю генерацию целиком.
    function repairTruncatedJson(text) {
        const objIdx = text.indexOf('{');
        const arrIdx = text.indexOf('[');
        let start;
        if (objIdx === -1) start = arrIdx;
        else if (arrIdx === -1) start = objIdx;
        else start = Math.min(objIdx, arrIdx);
        if (start === -1) return null;

        const stack = [];
        let inString = false;
        let escaped = false;
        let safeCut = -1;
        let safeStack = null;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { if (inString) escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (ch === '{' || ch === '[') {
                stack.push(ch === '{' ? '}' : ']');
            } else if (ch === '}' || ch === ']') {
                stack.pop();
                if (stack.length === 0) return null; // структура целая — чинить нечего
                // Точка, в которой закончился очередной вложенный элемент: отсюда можно резать
                safeCut = i + 1;
                safeStack = stack.slice();
            }
        }

        if (!stack.length || safeCut === -1) return null;

        const head = text.slice(start, safeCut).replace(/,\s*$/, '');
        return head + safeStack.reverse().join('');
    }

    function escapeRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Наши скрытые теги (data-nova-relationship, data-nova-music, data-iig-instruction
    // и т.д.) несут JSON в одинарных кавычках вида ='{"key":"value"}' — но сама эта строка
    // живёт ВНУТРИ JSON-строки "messages":[...]. Модель почти никогда не экранирует
    // вложенные двойные кавычки (\"), из-за чего внешний JSON.parse разваливается ещё до
    // того, как мы вообще добираемся до разбора самого тега. Правим это заранее в сыром
    // тексте ответа — надёжнее, чем рассчитывать, что промпт заставит модель делать
    // двойное экранирование правильно.
    function escapeNestedTagQuotes(text) {
        return text.replace(/='\{[^}]*\}'/g, span => {
            const inner = span.slice(2, -1);
            return "='" + inner.replace(/(?<!\\)"/g, '\\"') + "'";
        });
    }

    // Модель иногда переусердствует с экранированием — чаще всего апостроф как \'
    // (например в "I'm Drowning"), но не только. \' НЕ валидный JSON escape
    // (разрешены только \" \\ \/ \b \f \n \r \t \uXXXX), и JSON.parse падает на
    // этом месте целиком, теряя весь ответ.
    // Узкий фикс вида text.replace(/\\'/g, "'") тут в лоб не работает: если перед
    // апострофом стоят ДВЕ настоящих backslash (\\' — валидная пара \\ + голый
    // апостроф, экранировать нечего), такая замена СЛОМАЕТ уже валидный JSON,
    // просто убрав не тот backslash. Вместо угадывания конкретных символов идём
    // по каждой паре backslash+следующий_символ и убираем backslash только если
    // следующий символ НЕ входит в легальный набор JSON escape — тогда валидные
    // \" \\ \n и т.д. остаются нетронутыми при любой вложенности.
    const VALID_JSON_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
    function fixInvalidEscapes(text) {
        return text.replace(/\\(.)/gs, (match, ch) => (VALID_JSON_ESCAPE_CHARS.has(ch) ? match : ch));
    }

    const DEFAULT_REASONING_TAGS = [
        ['<think>', '</think>'],
        ['<thinking>', '</thinking>'],
        ['<reasoning>', '</reasoning>'],
    ];

    /**
     * Вырезает размышления, написанные прямо в тексте ответа.
     * Первым идёт Reasoning Template пользователя из Advanced Formatting — теги там могут быть любыми.
     */
    /**
     * Пары тегов, по которым режем размышления. Порядок приоритета:
     * свои настройки NOVA → шаблон рассуждений Таверны → общеизвестные теги.
     * Как и в Таверне, пара учитывается только если заполнены ОБА поля.
     */
    function getReasoningTagPairs(ctx) {
        const settings = ctx?.extensionSettings?.NOVA || {};
        const pairs = [];

        const ownPrefix = String(settings.reasoning_prefix ?? NOVA_GEN_DEFAULTS.reasoning_prefix).trim();
        const ownSuffix = String(settings.reasoning_suffix ?? NOVA_GEN_DEFAULTS.reasoning_suffix).trim();
        if (ownPrefix && ownSuffix) pairs.push([ownPrefix, ownSuffix]);

        const template = ctx?.powerUserSettings?.reasoning;
        if (template?.prefix && template?.suffix) pairs.push([template.prefix, template.suffix]);

        pairs.push(...DEFAULT_REASONING_TAGS);

        const seen = new Set();
        return pairs.filter(([prefix, suffix]) => {
            const key = `${prefix}::${suffix}`.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function stripReasoningBlocks(text) {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const settings = ctx?.extensionSettings?.NOVA || {};

        // Авто-парсинг, как в Таверне: выключен — текст уходит в разбор как есть
        if (settings.reasoning_auto_parse === false) return String(text).trim();

        const pairs = getReasoningTagPairs(ctx);

        let result = String(text);

        // Мы сами преднаполнили ответ открывающим тегом, значит настоящий ответ начинается
        // только ПОСЛЕ закрывающего. Нет закрывающего — модель не доехала дальше размышлений,
        // и всё, что пришло, это черновик. Отдавать его парсеру нельзя.
        const prefill = getStartReplyWith(ctx);
        if (prefill) {
            const suffix = pairs.find(([prefix]) => prefix.toLowerCase() === prefill.toLowerCase())?.[1];
            if (suffix && !result.toLowerCase().includes(suffix.toLowerCase())) {
                console.warn('[NOVA] Ответ оборвался внутри размышлений — закрывающего тега нет, ответа тоже.');
                return '';
            }
        }
        for (const [prefix, suffix] of pairs) {
            result = result.replace(
                new RegExp(`${escapeRegex(prefix)}[\\s\\S]*?${escapeRegex(suffix)}`, 'gi'),
                '',
            );

            // Ответ преднаполнен открывающим тегом («Начинать ответ с»): в content он не приходит,
            // модель продолжает с него — поэтому остаётся осиротевший закрывающий тег.
            // Всё до него включительно и есть размышления.
            let lower = result.toLowerCase();
            const orphanCloseIdx = lower.indexOf(suffix.toLowerCase());
            if (orphanCloseIdx !== -1) {
                result = result.slice(orphanCloseIdx + suffix.length);
                lower = result.toLowerCase();
            }

            // Ответ оборвался ВНУТРИ размышлений — закрывающего тега нет, и регулярка выше промахнулась.
            // Без этого черновик JSON из размышлений уезжает в парсер вместо настоящего ответа.
            const openIdx = lower.indexOf(prefix.toLowerCase());
            if (openIdx !== -1) {
                console.warn('[NOVA] Ответ оборвался внутри размышлений — отбрасываем незакрытый блок.');
                result = result.slice(0, openIdx);
            }
        }
        return result.trim();
    }

    // Helper: Safely parse JSON from markdown
    function parseJSONFromText(input) {
        const text = typeof input === 'string' ? input : extractTextFromResponse(input);
        if (!text) {
            console.error("[NOVA] Empty AI response, nothing to parse:", input);
            return null;
        }

        const cleaned = escapeNestedTagQuotes(fixInvalidEscapes(stripReasoningBlocks(text)));

        const candidates = [];
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced) candidates.push(fenced[1]);
        candidates.push(cleaned);
        const balanced = extractBalancedJson(cleaned);
        if (balanced) candidates.push(balanced);

        for (const candidate of candidates) {
            const parsed = tryParseJson(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        }

        const repaired = repairTruncatedJson(cleaned);
        if (repaired) {
            const parsed = tryParseJson(repaired);
            if (parsed && typeof parsed === 'object') {
                console.warn('[NOVA] Ответ оборвался (лимит токенов) — восстановлена усечённая часть JSON.');
                toastr.warning('Ответ модели оборвался по лимиту токенов — часть постов потеряна. Увеличьте лимит или снизьте «Рассуждения».', 'NOVA');
                return parsed;
            }
        }

        console.error("[NOVA] Failed to parse JSON from AI response:", text);
        return null;
    }

    /**
     * Запрашивает у модели JSON и проверяет, что он годный — общий паттерн для
     * всех мест, где мы ждём строго JSON в ответ. Без автоматических пересдач:
     * на некоторых моделях/бэкендах невалидный JSON — не разовая случайность, а
     * систематика (например, конкретно на Gemini Flash через Vertex), и лишний
     * запрос там только жжёт токены и время, ничего не решая.
     * @param {string} prompt
     * @param {string[]} images
     * @param {(data: any) => boolean} isValid — true, если результат годится
     * @param {string} [errorMessage]
     * @returns {Promise<any>}
     */
    async function callAIForJson(prompt, images = [], isValid, errorMessage = 'Invalid JSON structure') {
        const responseText = await callAI(prompt, images);
        const data = parseJSONFromText(responseText);
        if (data && isValid(data)) return data;
        console.error('[NOVA] Модель вернула невалидный JSON:', responseText);
        throw new Error(errorMessage);
    }

    function transliterate(text) {
        const ru = {
            'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 
            'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 
            'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 
            'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 
            'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 
            'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 
            'э': 'e', 'ю': 'yu', 'я': 'ya'
        };
        const result = text.toLowerCase().split('').map(char => ru[char] || char).join('').replace(/[^a-z0-9_]/g, '');
        return result.length > 0 ? result : 'user_' + Math.floor(Math.random() * 1000);
    }

    /**
     * Сжимаем ДО загрузки: с телефона прилетают снимки на 5-10 МБ, а в ленте картинка
     * всё равно показывается шириной с пост. Заодно это единственное, что уходит в модель
     * при vision-запросе, так что мегабайты там тоже ни к чему.
     */
    function compressImageFile(file, maxDim = 1280, quality = 0.82) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Не удалось открыть изображение'));
                img.onload = () => {
                    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        });
    }

    /**
     * Кладём картинку в папку пользователя Таверны и храним ПУТЬ, а не base64:
     * лента живёт в extensionSettings, которые целиком уходят на сервер при каждом сохранении.
     * @returns {Promise<string>} путь вида user/images/NOVA/....jpg
     */
    async function uploadNovaImage(dataUrl, suffix = '', ext = 'jpeg') {
        const base64 = String(dataUrl).split(',')[1];
        if (!base64) throw new Error('Пустое изображение');
        return await saveBase64AsFile(base64, 'NOVA', `nova_${Date.now()}${suffix}`, ext);
    }

    /**
     * Аватарка или шапка профиля после кадрирования — файлом, а не base64.
     *
     * Раньше кроппер отдавал data URL, и он ложился прямо в настройки: одна аватарка
     * на 162 КБ жила в charProfiles как строка. Картинки поста так не хранятся уже
     * давно (см. uploadNovaImage) — профили просто остались единственным исключением.
     *
     * Если загрузка не удалась, возвращаем исходный data URL: пусть лучше настройки
     * потолстеют, чем пользователь потеряет выбранную картинку.
     */
    async function storeProfileImage(dataUrl) {
        const value = String(dataUrl || '');
        if (!value.startsWith('data:')) return dataUrl;
        try {
            // Круглая обрезка отдаёт PNG ради прозрачности — расширение должно
            // совпасть с содержимым, иначе прозрачный угол уедет в чёрный квадрат
            const ext = value.startsWith('data:image/png') ? 'png' : 'jpeg';
            return await uploadNovaImage(value, '_profile', ext);
        } catch (e) {
            console.warn('[NOVA] Не удалось сохранить картинку профиля файлом — оставляем как есть', e);
            return dataUrl;
        }
    }

    /**
     * Уменьшенная копия картинки для превью в ленте/DM/галерее: пост сгенерирован
     * в 1К-4К, а превью в разметке не крупнее ~340px (лента) или ~150px (галерея) —
     * грузить и держать в памяти полный файл ради этого незачем. 640px с запасом
     * покрывает даже retina-экран на ширине панели. Полный файл открывается
     * только во вьюере на весь экран.
     */
    function makeThumbnailDataUrl(dataUrl, maxDim = 640, quality = 0.78) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                    const w = Math.max(1, Math.round(img.width * scale));
                    const h = Math.max(1, Math.round(img.height * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch {
                    resolve(null); // не вышло — вьюстрою обойдёмся без превью, покажем полный файл
                }
            };
            img.onerror = () => resolve(null);
            img.src = dataUrl;
        });
    }

    /**
     * Грузит и полную картинку, и её уменьшенное превью. Использовать вместо
     * uploadNovaImage везде, где результат становится image поста/DM-сообщения
     * (то есть попадёт в ленту/галерею) — аватарам и референсам превью не нужно.
     * @returns {Promise<{image: string, thumbnail: string}>}
     */
    async function uploadNovaImageWithThumbnail(dataUrl) {
        const image = await uploadNovaImage(dataUrl);
        let thumbnail = image;
        try {
            const thumbDataUrl = await makeThumbnailDataUrl(dataUrl);
            if (thumbDataUrl) thumbnail = await uploadNovaImage(thumbDataUrl, '_thumb');
        } catch (e) {
            console.warn('[NOVA] Превью не сгенерировано, будет показываться полный файл', e);
        }
        return { image, thumbnail };
    }

    // Разметка картинки поста/сообщения — одна на все места вывода
    function renderAttachedImage(item, extraStyle = '') {
        if (!item) return '';

        // Эти координаты нужны не только готовой картинке (открыть вьюер), но и
        // затычке неудачной генерации (кнопка «Повторить») — считаем их один раз
        const type = item.type || (item.feedIndex !== undefined ? 'post' : (item.sender ? 'dm' : ''));
        const fIndex = item.feedIndex !== undefined ? item.feedIndex : '';
        const rPath = item.replyPath || '';
        const mIndex = item.msgIndex !== undefined ? item.msgIndex : '';
        const dataAttrs = `data-type="${type}" data-findex="${fIndex}" data-rpath="${rPath}" data-mindex="${mIndex}"`;

        // Текст поста показываем сразу, не дожидаясь картинки — на её месте крутится
        // спиннер, а если генерация упала, вместо вечного спиннера встаёт затычка
        if (!item.image && item.imagePending) {
            // Несколько картинок в пачке рисуются строго по очереди (см.
            // attachGeneratedImages), но без подписи это незаметно — все спиннеры
            // появляются разом и выглядят так, будто всё генерируется параллельно.
            const queueLabel = item.imageQueueTotal > 1
                ? `<span>${item.imageQueueActive ? 'Генерируется' : 'В очереди'} ${item.imageQueuePos}/${item.imageQueueTotal}</span>`
                : '';
            return `<div class="nova-image-pending" style="${extraStyle}"><i class="fa-solid fa-spinner fa-spin"></i>${queueLabel}</div>`;
        }
        if (!item.image && item.imageFailed) {
            return `<div class="nova-image-failed" style="${extraStyle}" title="Не удалось сгенерировать картинку">
                <i class="fa-solid fa-image-slash"></i>
                <span>Не удалось сгенерировать</span>
                <button type="button" class="nova-image-retry-btn" ${dataAttrs}><i class="fa-solid fa-rotate-right"></i> Повторить</button>
            </div>`;
        }
        if (!item.image) return '';

        if (!item.imageVersions) {
            item.imageVersions = [{ image: item.image, thumbnail: item.thumbnail, prompt: item.image_prompt || item.imagePrompt, opts: item.image_opts }];
            item.imageVersionIndex = 0;
        }

        // В разметке — только превью: полный файл открывается позже, во вьюере,
        // который сам подтянет item.image из настоящего объекта
        const imgTag = `<img class="nova-attached-image" src="${item.thumbnail || item.image}" onclick="window.novaOpenImageViewer(this)" loading="lazy" style="${item.imageRegenerating ? '' : extraStyle}" ${dataAttrs}>`;

        // Перегенерация СУЩЕСТВУЮЩЕЙ картинки (🔄/✏️ во вьюере) не трогает
        // imagePending — старое изображение никуда не девается, пока не придёт
        // новое. Без этого значка фон (лента/тред), если из него уйти во время
        // перегенерации, выглядел так, будто вообще ничего не происходит.
        if (!item.imageRegenerating) return imgTag;
        return `<div class="nova-attached-image-wrap" style="${extraStyle}">
            ${imgTag}
            <div class="nova-image-regenerating-badge" title="Генерируется новая версия"><i class="fa-solid fa-spinner fa-spin"></i></div>
        </div>`;
    }

    /** Достаёт настоящий пост/ответ/DM-сообщение по координатам из data-атрибутов
     *  разметки — общий резолвер для открытия вьюера и для кнопки «Повторить». */
    function resolveRenderedItem(type, fIndex, rPath, mIndex) {
        if (type === 'post') {
            return feedPosts[fIndex] || null;
        }
        if (type === 'reply') {
            let targetArray = feedPosts[fIndex]?.replies;
            const pathParts = String(rPath).split(',').filter(Boolean).map(Number);
            for (let i = 0; i < pathParts.length - 1; i++) {
                if (targetArray) targetArray = targetArray[pathParts[i]]?.replies;
            }
            return targetArray ? (targetArray[pathParts[pathParts.length - 1]] || null) : null;
        }
        if (type === 'dm') {
            const threadHandle = $('#nova-view-single-dm').attr('data-thread-handle');
            const thread = dmThreads.find(t => t.handle === threadHandle);
            return thread?.messages ? (thread.messages[mIndex] || null) : null;
        }
        return null;
    }

    /**
     * Подгоняет высоту textarea под содержимое. Потолок берём из max-height в CSS,
     * чтобы поле не выросло на весь экран — дальше включается обычный скролл.
     *
     * Вызывать нужно не только на ввод, но и после программной подстановки значения
     * (.val() события input не порождает) — иначе загруженный пресет остаётся
     * схлопнутым в одну строку, хотя текста в нём на несколько.
     */
    function autoGrowTextarea(el) {
        if (!el) return;
        // У поля на скрытой вкладке scrollHeight равен нулю — подогнать высоту
        // сейчас значило бы схлопнуть его; пересчитаем, когда вкладку откроют
        if (!el.scrollHeight) return;
        const max = parseInt(window.getComputedStyle(el).maxHeight, 10);
        el.style.height = 'auto';
        const target = Number.isFinite(max) ? Math.min(el.scrollHeight, max) : el.scrollHeight;
        el.style.height = target + 'px';
        el.style.overflowY = el.scrollHeight > target ? 'auto' : 'hidden';
    }

    $(document).on('input', 'textarea.nova-autogrow', function() {
        autoGrowTextarea(this);
    });

    // Глобальная функция для обработки тапов на мобилках в обход кэша и багов делегирования
    window.novaOpenImageViewer = function(el) {
        const $el = $(el);
        const item = resolveRenderedItem($el.data('type'), $el.data('findex'), $el.data('rpath'), $el.data('mindex'));

        if (item) {
            openImageViewer(item);
        } else {
            openImageViewer({ image: $el.attr('src') });
        }
    };

    $(document).on('click', '.nova-attached-image', function(e) {
        if ($(this).closest('.nova-gallery-item').length) return; // Галерея обрабатывает сама
        window.novaOpenImageViewer(this);
    });

    /** Обновляет открытый тред/переписку, если картинка только что появилась или
     *  упала именно у него — иначе фон (лента/список DM) обновляется, а открытая
     *  поверх него страница поста/переписки остаётся со старым спиннером/затычкой. */
    function refreshOpenDetailViewsFor(items) {
        const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
        if (!list.length) return;

        if ($('#nova-view-single-post').hasClass('active')) {
            const openIndex = Number($('#nova-single-post-main [data-item-type="main-post"]').data('index'));
            if (!Number.isNaN(openIndex) && list.some(it => {
                const ctx = locateItemContext(it);
                return (ctx.type === 'post' || ctx.type === 'reply') && ctx.feedIndex === openIndex;
            })) {
                openSinglePost(openIndex);
            }
        }

        if ($('#nova-view-single-dm').hasClass('active')) {
            const threadHandle = $('#nova-view-single-dm').attr('data-thread-handle');
            const threadIndex = dmThreads.findIndex(t => t.handle === threadHandle);
            if (threadIndex !== -1 && list.some(it => locateItemContext(it).threadHandle === threadHandle)) {
                openSingleDM(threadIndex);
            }
        }
    }

    /** Повторная генерация одной конкретной картинки — с кнопки «Повторить» на
     *  затычке неудачной генерации. Промпт для неё сохранён в item.imagePrompt
     *  ещё в attachGeneratedImages, даже если попытка провалилась. */
    async function retryFailedImage(item) {
        if (!item) return;
        if (!String(item.imagePrompt || '').trim()) {
            // Затычки, упавшие ДО того, как мы стали сохранять промпт для повтора,
            // повторить нечем — молча ничего не делать хуже, чем объяснить, почему
            toastr.warning('У этой картинки не сохранился промпт — повторить нечем. Перегенерируйте пост целиком.', 'NOVA');
            return;
        }
        item.image_prompt = item.imagePrompt;
        delete item.imageFailed;
        // Выставляем pending ЗДЕСЬ, а не полагаемся на то, что это сделает
        // attachGeneratedImages: тот факт становится true только на первой
        // итерации своего цикла, а между этой строкой и первым refresh() ниже
        // ничего не гарантирует, что рендер не поймает item без всех трёх
        // флагов сразу — ни затычки, ни спиннера, только пустое место
        // (ровно то, что показал скриншот бага).
        item.imagePending = true;

        const refresh = () => {
            saveFeed();
            renderFeed();
            renderDMs();
            refreshOpenDetailViewsFor(item);
        };
        refresh(); // спиннер вместо затычки должен появиться сразу, не после ответа сервера
        const done = await attachGeneratedImages([item], refresh);
        // Бюджет картинок мог за это время обнулиться в настройках — тогда
        // attachGeneratedImages выходит рано, ничего в item не трогая. imagePending,
        // который мы выставили выше, так и останется висеть, а рендер спиннера
        // проверяется РАНЬШЕ затычки — картинка застряла бы с крутящимся
        // спиннером навсегда вместо понятной ошибки.
        if (!done && !item.image) {
            delete item.imagePending;
            item.imageFailed = true;
            delete item.image_prompt;
            refresh();
        }
    }

    $(document).on('click', '.nova-image-retry-btn', function(e) {
        e.stopPropagation();
        const $el = $(this);
        const item = resolveRenderedItem($el.data('type'), $el.data('findex'), $el.data('rpath'), $el.data('mindex'));
        if (item) retryFailedImage(item);
    });
    const pendingImages = { post: null, dm: null };

    async function attachPendingImage(slot, file, previewSelector) {
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            toastr.warning('Это не изображение.');
            return;
        }
        try {
            const dataUrl = await compressImageFile(file);
            pendingImages[slot] = dataUrl;
            $(previewSelector).show().find('img').attr('src', dataUrl);
        } catch (e) {
            console.error('[NOVA] Не удалось подготовить изображение', e);
            toastr.error('Не удалось обработать изображение: ' + (e.message || ''));
        }
    }

    function clearPendingImage(slot) {
        pendingImages[slot] = null;
        const selector = slot === 'post' ? '#nova-create-post-image-preview' : '#nova-dm-image-preview';
        $(selector).hide().find('img').attr('src', '');
    }

    /** Экранирование для вставки текста в атрибут или в тело тега. */
    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Находит, откуда вообще взялся item — пост, ответ или DM-сообщение — по ссылке
     * на сам объект, а не по служебным полям вроде item.type/item.feedIndex: их
     * проставляют только на ВРЕМЕННЫХ копиях для рендера ({...post, type: 'post', ...}),
     * а openImageViewer получает настоящий объект из feedPosts/dmThreads, где этих
     * полей никогда не было. Раньше проверка на item.type === 'post' была всегда
     * false, и открытый просмотр поста/переписки не обновлялся после смены версии —
     * пользователь выбирал понравившуюся картинку, закрывал вьюер, а под ним
     * по-прежнему висела старая (первая сгенерированная).
     */
    function locateItemContext(item) {
        const findInReplies = (replies) => {
            for (const r of (replies || [])) {
                if (r === item) return true;
                if (findInReplies(r.replies)) return true;
            }
            return false;
        };
        for (let i = 0; i < feedPosts.length; i++) {
            const post = feedPosts[i];
            if (post === item) return { type: 'post', feedIndex: i };
            if (findInReplies(post.replies)) return { type: 'reply', feedIndex: i };
        }
        for (let i = 0; i < dmThreads.length; i++) {
            const thread = dmThreads[i];
            if ((thread.messages || []).includes(item)) return { type: 'dm', threadIndex: i, threadHandle: thread.handle };
        }
        return {};
    }

    function openImageViewer(item, galleryNav = null) {
        if (!item || !item.image) return;

        $('#nova-image-viewer').remove();

        const ctx = locateItemContext(item);
        // Досоздаёт актуальную картинку под открытым постом/перепиской после
        // смены или перегенерации версии — вьюер и список за ним не должны разъезжаться.
        const refreshOpenViews = () => {
            if ((ctx.type === 'post' || ctx.type === 'reply') && $('#nova-view-single-post').hasClass('active')) {
                openSinglePost(ctx.feedIndex);
            }
            if (ctx.type === 'dm' && $('#nova-view-single-dm').hasClass('active') && $('#nova-view-single-dm').attr('data-thread-handle') === ctx.threadHandle) {
                openSingleDM(ctx.threadIndex);
            }
        };

        // Убедимся, что история версий инициализирована
        if (!item.imageVersions) {
            item.imageVersions = [{ image: item.image, thumbnail: item.thumbnail, prompt: item.image_prompt || item.imagePrompt, opts: item.image_opts }];
            item.imageVersionIndex = 0;
        }

        // Размер вьюера снимаем ОДИН раз при открытии и держим его: 100dvh/100svh
        // пересчитывается, когда на мобилке открывается клавиатура (для поля
        // промпта) — фон-картинка то сжималась, то отпускалась при каждом фокусе
        // на textarea. Обновляем размер только при РЕАЛЬНОМ повороте экрана
        // (у него меняется ширина), а не когда меняется только высота из-за клавиатуры.
        let viewerWidth = window.innerWidth;
        let viewerHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

        // Пользователь закрыл вьюер, пока в фоне ещё шла перегенерация — нельзя
        // молча затащить его обратно во весь экран, когда картинка придёт.
        // Лента/тред и так обновятся сами (refreshOpenViews/renderFeed).
        let viewerClosed = false;

        // Открыть другую картинку ИЗ ЭТОГО ЖЕ вьюера, листая список галереи, а не
        // версии одной картинки — отдельная навигация, не путать с prev/next версий.
        const openGalleryAt = (index) => {
            const total = galleryNav.items.length;
            const nextIndex = ((index % total) + total) % total;
            const nextItem = galleryNav.items[nextIndex];
            viewerClosed = true; // подавляем renderViewer() у текущего замыкания, открываем новое
            $(window).off('resize.novaImageViewer resize.novaEditPanel');
            if (window.visualViewport) $(window.visualViewport).off('resize.novaEditPanel scroll.novaEditPanel');
            $('#nova-image-viewer').remove();
            if (nextItem) openImageViewer(nextItem, { items: galleryNav.items, index: nextIndex });
        };

        const handleViewerResize = () => {
            const newWidth = window.innerWidth;
            if (Math.abs(newWidth - viewerWidth) < 40) return;
            viewerWidth = newWidth;
            viewerHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            $('#nova-image-viewer').css({ width: `${viewerWidth}px`, height: `${viewerHeight}px` });
        };
        $(window).off('resize.novaImageViewer').on('resize.novaImageViewer', handleViewerResize);

        // Панель промпта, в отличие от фона, ДОЛЖНА следовать за клавиатурой: она
        // position:fixed сама по себе, а её позицию держим синхронно с
        // visualViewport (единственный источник, который реально знает, сколько
        // экрана осталось видно над клавиатурой на мобилке).
        const positionEditPanel = () => {
            const $panel = $('#nova-image-viewer-edit-panel');
            if (!$panel.length) return;
            const vv = window.visualViewport;
            const visibleHeight = vv ? vv.height : window.innerHeight;
            const visibleTop = vv ? vv.offsetTop : 0;
            $panel.css({
                top: `${visibleTop + visibleHeight / 2}px`,
                left: '50%',
                transform: 'translate(-50%, -50%)',
                maxHeight: `${Math.max(160, visibleHeight - 32)}px`,
            });
        };
        if (window.visualViewport) {
            $(window.visualViewport).off('resize.novaEditPanel scroll.novaEditPanel')
                .on('resize.novaEditPanel scroll.novaEditPanel', positionEditPanel);
        } else {
            $(window).off('resize.novaEditPanel').on('resize.novaEditPanel', positionEditPanel);
        }

        const renderViewer = () => {
            const currentVersion = item.imageVersions[item.imageVersionIndex];
            const text = String(currentVersion.prompt || '').trim();

            const versionCount = item.imageVersions.length;
            // Листалка версий и листалка галереи занимают одно и то же место —
            // показывать разом обе избыточно, а открыт вьюер всегда из чего-то
            // одного: либо из поста (там смысл имеют версии), либо из галереи
            // (там смысл имеет соседняя фотка, у неё свой собственный item).
            const showGalleryNav = galleryNav && galleryNav.items.length > 1;
            const hasVersions = !showGalleryNav && versionCount > 1;
            // Своя загруженная фотка — не сгенерированная, перерисовывать нечего
            // и незачем: у неё нет промпта генерации, а imagePrompt (если есть) —
            // это подпись модели, а не инструкция для перерисовки.
            const canRegenerate = !item.userPhoto;

            const $overlay = $(`
                <div id="nova-image-viewer" class="active" style="display: flex !important; z-index: 100030; background: black; flex-direction: column; position: fixed; top: 0; left: 0; margin: 0 !important; width: ${viewerWidth}px; height: ${viewerHeight}px;">
                    <div class="nova-photo-viewer-image-container" style="width: 100%; height: 100%; flex: 1 1 auto; position: relative; overflow: hidden;">
                        <img src="${currentVersion.image}" alt="" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; transition: transform 0.1s ease-out; transform-origin: center center; will-change: transform;">
                    </div>

                    <div class="nova-icon-btn" id="nova-image-viewer-close" title="Закрыть" style="position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.12); z-index: 20; color: white; border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; cursor: pointer;">
                        <i class="fa-solid fa-xmark"></i>
                    </div>

                    <div class="nova-photo-edit-prompt-overlay" id="nova-image-viewer-edit-panel" style="position: fixed; width: min(92vw, 480px); box-sizing: border-box; background: rgba(30, 30, 30, 0.97); border: 1px solid var(--nova-border); border-radius: 14px; padding: 16px; display: none; flex-direction: column; gap: 12px; z-index: 20; pointer-events: auto; backdrop-filter: blur(10px); overflow-y: auto;">
                        <textarea id="nova-image-viewer-prompt-input" style="width: 100%; height: 160px; background: rgba(0,0,0,0.5); border: 1px solid var(--nova-border); border-radius: 8px; padding: 12px; color: white; font-family: inherit; font-size: 14px; line-height: 1.4; resize: vertical; box-sizing: border-box;"></textarea>
                        <div style="display: flex; gap: 10px; justify-content: space-between; align-items: center;">
                            <button id="nova-image-viewer-copy-prompt" title="Копировать промпт" style="background: transparent; color: var(--nova-text-muted); border: 1px solid var(--nova-border); border-radius: 8px; width: 38px; height: 38px; flex: 0 0 auto; cursor: pointer; display: flex; align-items: center; justify-content: center;"><i class="fa-regular fa-copy"></i></button>
                            <div style="display: flex; gap: 10px;">
                                <button id="nova-image-viewer-edit-cancel" style="background: transparent; color: white; border: none; padding: 8px 16px; cursor: pointer;">Отмена</button>
                                <button id="nova-image-viewer-edit-confirm" style="background: var(--nova-accent); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: bold; white-space: nowrap;">Сохранить</button>
                            </div>
                        </div>
                    </div>

                    ${hasVersions ? `
                    <!-- Раньше тут была ОДНА кнопка «откатить», которая крутит версии только назад
                         по кругу — пролистав мимо понравившейся, вернуться к ней можно было только
                         докрутив весь список заново, и без счётчика непонятно было даже сколько версий
                         вообще есть. Теперь — обе стороны и видно, где именно ты находишься. -->
                    <div class="nova-photo-viewer-versions" style="position: absolute; bottom: 96px; left: 0; right: 0; display: flex; justify-content: center; align-items: center; gap: 14px; z-index: 10; pointer-events: none;">
                        <div class="nova-icon-btn" id="nova-image-viewer-prev" title="Предыдущая версия" style="pointer-events: auto; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15); color: white; font-size: 15px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px);">
                            <i class="fa-solid fa-chevron-left"></i>
                        </div>
                        <div style="pointer-events: none; color: white; font-size: 13px; font-weight: 600; min-width: 46px; text-align: center; background: rgba(0,0,0,0.45); padding: 5px 10px; border-radius: 12px; text-shadow: 0 1px 2px rgba(0,0,0,0.6);">${item.imageVersionIndex + 1} / ${versionCount}</div>
                        <div class="nova-icon-btn" id="nova-image-viewer-next" title="Следующая версия" style="pointer-events: auto; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15); color: white; font-size: 15px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px);">
                            <i class="fa-solid fa-chevron-right"></i>
                        </div>
                    </div>` : ''}

                    ${showGalleryNav ? `
                    <div class="nova-photo-viewer-versions" style="position: absolute; bottom: 96px; left: 0; right: 0; display: flex; justify-content: center; align-items: center; gap: 14px; z-index: 10; pointer-events: none;">
                        <div class="nova-icon-btn" id="nova-image-viewer-gallery-prev" title="Предыдущее фото" style="pointer-events: auto; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15); color: white; font-size: 15px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px);">
                            <i class="fa-solid fa-chevron-left"></i>
                        </div>
                        <div style="pointer-events: none; color: white; font-size: 13px; font-weight: 600; min-width: 46px; text-align: center; background: rgba(0,0,0,0.45); padding: 5px 10px; border-radius: 12px; text-shadow: 0 1px 2px rgba(0,0,0,0.6);">${galleryNav.index + 1} / ${galleryNav.items.length}</div>
                        <div class="nova-icon-btn" id="nova-image-viewer-gallery-next" title="Следующее фото" style="pointer-events: auto; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.15); color: white; font-size: 15px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px);">
                            <i class="fa-solid fa-chevron-right"></i>
                        </div>
                    </div>` : ''}

                    <div class="nova-photo-viewer-actions" style="position: absolute; bottom: 0; left: 0; right: 0; padding: 16px; padding-bottom: max(32px, calc(env(safe-area-inset-bottom, 0px) + 24px)); background: linear-gradient(to top, rgba(0,0,0,0.8), transparent); display: flex; justify-content: center; gap: 24px; z-index: 10; pointer-events: none;">
                        ${canRegenerate ? `
                        <div class="nova-icon-btn" id="nova-image-viewer-regenerate" title="Перегенерировать (тот же промпт)" style="pointer-events: auto; width: 48px; height: 48px; border-radius: 50%; background: rgba(255, 255, 255, 0.15); color: white; font-size: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px); transition: background 0.2s, transform 0.1s;">
                            <i class="fa-solid fa-sync-alt"></i>
                        </div>
                        <div class="nova-icon-btn" id="nova-image-viewer-edit" title="Изменить промпт" style="pointer-events: auto; width: 48px; height: 48px; border-radius: 50%; background: rgba(255, 255, 255, 0.15); color: white; font-size: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px); transition: background 0.2s, transform 0.1s;">
                            <i class="fa-solid fa-edit"></i>
                        </div>` : ''}
                        <div class="nova-icon-btn" id="nova-image-viewer-download" title="Скачать в полном качестве" style="pointer-events: auto; width: 48px; height: 48px; border-radius: 50%; background: rgba(255, 255, 255, 0.15); color: white; font-size: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; backdrop-filter: blur(8px); transition: background 0.2s, transform 0.1s;">
                            <i class="fa-solid fa-download"></i>
                        </div>
                    </div>
                </div>
            `);

            $('#nova-image-viewer').remove();
            $('#nova-backdrop').append($overlay);

            // Логика жестов (pinch-to-zoom, drag)
            const $img = $overlay.find('img');
            let scale = 1;
            let currentX = 0;
            let currentY = 0;
            let startDistance = 0;
            let initialScale = 1;
            
            // Состояние drag
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let imgStartX = 0;
            let imgStartY = 0;

            // Был ли в ТЕКУЩЕМ жесте момент с двумя пальцами. Когда щипок отпускают,
            // пальцы поднимаются по одному, каждый — отдельным touchend. Без этого флага
            // подъём ВТОРОГО пальца (0 оставшихся касаний) читался обработчиком двойного
            // тапа как одиночный тап и дёргал/сбрасывал зум сразу после того, как
            // пользователь его выставил щипком.
            let pinchActive = false;

            const updateTransform = (animate = false) => {
                $img.css('transition', animate ? 'transform 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94)' : 'none');
                $img.css('transform', `translate3d(${currentX}px, ${currentY}px, 0) scale(${scale})`);
            };

            const getDistance = (touches) => {
                if (touches.length < 2) return 0;
                return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
            };
            
            // Панель редактирования промпта и кнопки действий — это ДЕТИ $overlay,
            // а touch-события всплывают. Без этой проверки жесты картинки (свайп вниз
            // закрывает вьювер, drag двигает её) перехватывают тап или свайп по textarea —
            // pointer-events тут не спасает, он влияет на хит-тест, а не на всплытие.
            const isViewerChrome = e => !!$(e.target).closest('.nova-photo-edit-prompt-overlay, .nova-photo-viewer-actions').length;

            // Touch события
            $overlay.on('touchstart', (e) => {
                if (isViewerChrome(e)) return;
                const touches = e.originalEvent?.touches || e.touches;
                if (!touches) return;

                // Сбрасывается тут, а не в touchend: обработчику двойного тапа для ЭТОГО
                // же touchend ещё нужно значение true, а сброс должен случиться только
                // на следующем, действительно НОВОМ жесте
                pinchActive = false;

                if (touches.length === 2) {
                    isDragging = false;
                    pinchActive = true;
                    startDistance = getDistance(touches);
                    initialScale = scale;

                    // Точка между пальцами становится центром зума, а не центр картинки —
                    // иначе щипок у края фото всё равно "тянет" изображение к середине
                    const rect = $img[0].getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        const midX = (touches[0].clientX + touches[1].clientX) / 2;
                        const midY = (touches[0].clientY + touches[1].clientY) / 2;
                        const originX = Math.min(100, Math.max(0, ((midX - rect.left) / rect.width) * 100));
                        const originY = Math.min(100, Math.max(0, ((midY - rect.top) / rect.height) * 100));
                        $img.css('transform-origin', `${originX}% ${originY}%`);
                    }
                } else if (touches.length === 1 && scale > 1) {
                    isDragging = true;
                    startX = touches[0].clientX;
                    startY = touches[0].clientY;
                    imgStartX = currentX;
                    imgStartY = currentY;
                } else if (touches.length === 1 && scale === 1) {
                    // Проверка на свайп вниз для закрытия
                    isDragging = true;
                    startX = touches[0].clientX;
                    startY = touches[0].clientY;
                    imgStartX = currentX;
                    imgStartY = currentY;
                }
            });

            $overlay.on('touchmove', (e) => {
                if (isViewerChrome(e)) return;
                const touches = e.originalEvent?.touches || e.touches;
                if (!touches) return;

                if (touches.length === 2) {
                    e.preventDefault(); // Остановить скролл страницы
                    const currentDistance = getDistance(touches);
                    if (startDistance > 0) {
                        scale = Math.max(1, Math.min(initialScale * (currentDistance / startDistance), 5));
                    }
                    
                    if (scale === 1) {
                        currentX = 0;
                        currentY = 0;
                    }
                    updateTransform(false);
                } else if (touches.length === 1 && isDragging) {
                    const deltaX = touches[0].clientX - startX;
                    const deltaY = touches[0].clientY - startY;
                    
                    if (scale > 1) {
                        e.preventDefault();
                        currentX = imgStartX + deltaX;
                        currentY = imgStartY + deltaY;
                        updateTransform(false);
                    } else if (scale === 1 && deltaY > 50 && Math.abs(deltaY) > Math.abs(deltaX)) {
                        e.preventDefault();
                        $overlay.css('opacity', Math.max(0, 1 - (deltaY - 50) / 200));
                        $img.css('transform', `translateY(${deltaY}px) scale(${1 - deltaY/1000})`);
                    }
                }
            });

            $overlay.on('touchend', (e) => {
                if (isViewerChrome(e)) return;
                const touches = e.originalEvent?.touches || e.touches;
                const changedTouches = e.originalEvent?.changedTouches || e.changedTouches;

                if (touches && touches.length < 2) {
                    if (scale > 1) {
                        updateTransform(true);
                    }
                }
                
                if (scale === 1 && isDragging && changedTouches && changedTouches[0]) {
                    const deltaY = changedTouches[0].clientY - startY;
                    const deltaX = changedTouches[0].clientX - startX;
                    // Горизонтальный свайп — это листалка галереи, а не закрытие;
                    // отличаем по тому, какая ось "победила" в этом жесте.
                    if (galleryNav && galleryNav.items.length > 1 && Math.abs(deltaX) > 60 && Math.abs(deltaX) > Math.abs(deltaY)) {
                        $overlay.css('opacity', 1);
                        updateTransform(true);
                        openGalleryAt(galleryNav.index + (deltaX < 0 ? 1 : -1));
                    } else if (deltaY > 100) {
                        closeViewer();
                    } else {
                        $overlay.css('opacity', 1);
                        updateTransform(true);
                    }
                }
                isDragging = false;
            });

            // Double tap zoom
            let lastTap = 0;
            $overlay.on('touchend', (e) => {
                if (isViewerChrome(e)) return;
                const touches = e.originalEvent?.touches || e.touches;
                const currentTime = new Date().getTime();
                const tapLength = currentTime - lastTap;
                // pinchActive исключает подъём второго пальца после щипка — см. комментарий
                // у объявления флага
                if (!pinchActive && tapLength < 300 && tapLength > 0 && (!touches || touches.length === 0)) {
                    scale = scale > 1 ? 1 : 2;
                    currentX = 0;
                    currentY = 0;
                    $img.css('transform-origin', 'center center');
                    updateTransform(true);
                }
                lastTap = currentTime;
            });

            // Wheel zoom for desktop
            $overlay.on('wheel', (e) => {
                if (isViewerChrome(e)) return;
                e.preventDefault();
                const delta = e.originalEvent.deltaY > 0 ? -0.1 : 0.1;
                scale = Math.max(1, Math.min(scale + delta, 5));
                if (scale === 1) {
                    currentX = 0;
                    currentY = 0;
                }
                updateTransform(true);
            });

            const closeViewer = () => {
                viewerClosed = true;
                $(window).off('resize.novaImageViewer resize.novaEditPanel');
                if (window.visualViewport) $(window.visualViewport).off('resize.novaEditPanel scroll.novaEditPanel');
                $overlay.remove();
            };
            $('#nova-image-viewer-close').on('click', closeViewer);

            $('#nova-image-viewer-gallery-prev').on('click', () => openGalleryAt(galleryNav.index - 1));
            $('#nova-image-viewer-gallery-next').on('click', () => openGalleryAt(galleryNav.index + 1));

            $('#nova-image-viewer-download').on('click', async () => {
                try {
                    const res = await fetch(currentVersion.image);
                    const blob = await res.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = `nova_${(item.handle || 'photo').replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.jpg`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
                } catch (e) {
                    console.error('[NOVA] Не удалось скачать картинку', e);
                    toastr.error('Не удалось скачать картинку: ' + (e.message || e));
                }
            });

            // Переключение версий — общая точка для «назад» и «вперёд»: обе кнопки
            // просто выбирают новый индекс и применяют версию по нему одинаково
            const applyVersionAt = (index) => {
                item.imageVersionIndex = index;
                const version = item.imageVersions[index];
                item.image = version.image;
                // Превью тоже переключаем на выбранную версию — иначе в ленте
                // после навигации по версиям остаётся картинка версии №1
                item.thumbnail = version.thumbnail || version.image;
                item.imagePrompt = version.prompt;
                item.image_prompt = version.prompt;
                item.image_opts = version.opts;
                saveFeed();
                renderFeed();
                refreshOpenViews();
                renderViewer(); // Перерисовка вьюера с новой картинкой и актуальным счётчиком
            };

            $('#nova-image-viewer-prev').on('click', () => {
                applyVersionAt((item.imageVersionIndex - 1 + item.imageVersions.length) % item.imageVersions.length);
            });
            $('#nova-image-viewer-next').on('click', () => {
                applyVersionAt((item.imageVersionIndex + 1) % item.imageVersions.length);
            });

            $('#nova-image-viewer-edit').on('click', () => {
                $('#nova-image-viewer-prompt-input').val(text);
                $('#nova-image-viewer-edit-panel').css('display', 'flex');
                positionEditPanel();
            });

            $('#nova-image-viewer-edit-cancel').on('click', () => {
                $('#nova-image-viewer-edit-panel').hide();
            });

            $('#nova-image-viewer-copy-prompt').on('click', async () => {
                const value = $('#nova-image-viewer-prompt-input').val();
                try {
                    await navigator.clipboard.writeText(value);
                    toastr.success('Промпт скопирован');
                } catch (e) {
                    toastr.error('Не удалось скопировать промпт');
                }
            });

            const triggerRegenerate = async (newPromptText = null) => {
                const profile = getActiveImageProfile();
                if (!profile) return toastr.warning('Не настроено подключение для генерации');

                const author = item.handle || item.sender_handle || item.senderName || '';
                const promptText = newPromptText !== null ? newPromptText : text;
                const opts = currentVersion.opts || {};
                
                $('#nova-image-viewer-edit-panel').hide();
                $overlay.find('.nova-photo-viewer-actions').css('opacity', 0.5);
                const $loader = $('<div class="nova-loader" style="position: absolute; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-circle-notch fa-spin fa-3x" style="color: white;"></i></div>');
                $overlay.append($loader);

                // Старое фото никуда не девается, пока не придёт новое — тут нет
                // "нет картинки" момента, который включил бы обычный imagePending.
                // Если сейчас закрыть вьюер и уйти в ленту/тред, там должно быть
                // видно, что с картинкой что-то происходит, а не старая версия
                // как ни в чём не бывало.
                item.imageRegenerating = true;
                renderFeed();
                refreshOpenViews();

                try {
                    const useRefs = profile.apiType === 'gemini' || profile.apiType === 'naistera';
                    const refs = useRefs ? await prepareReferences(matchReferences(author, promptText)) : [];
                    
                    const dataUrl = await generateNovaImage(promptText, profile, refs, opts);
                    const uploaded = dataUrl.startsWith('data:') ? await uploadNovaImageWithThumbnail(dataUrl) : { image: dataUrl, thumbnail: dataUrl };

                    // Добавляем новую версию
                    item.imageVersions.push({
                        image: uploaded.image,
                        thumbnail: uploaded.thumbnail,
                        prompt: promptText,
                        opts: opts
                    });
                    item.imageVersionIndex = item.imageVersions.length - 1;
                    item.image = uploaded.image;
                    item.thumbnail = uploaded.thumbnail;
                    item.imagePrompt = promptText;
                    item.image_prompt = promptText;
                    delete item.imageRegenerating;

                    saveFeed();
                    renderFeed();
                    refreshOpenViews();

                    // Пока генерация шла, пользователь мог закрыть вьюер и уйти читать
                    // ленту/переписку — новую картинку он уже увидел бы в них через
                    // refreshOpenViews/renderFeed. Затаскивать его обратно во весь
                    // экран против воли не нужно.
                    if (!viewerClosed) renderViewer();
                } catch (e) {
                    console.error('[NOVA] Ошибка перегенерации', e);
                    toastr.error('Ошибка: ' + (e.message || e));
                    delete item.imageRegenerating;
                    // Значок в фоне мог уже показаться (пользователь успел закрыть
                    // вьюер и уйти) — без этого он так и остался бы крутиться там
                    // вечно, хотя попытка давно провалилась
                    renderFeed();
                    refreshOpenViews();
                    $overlay.find('.nova-photo-viewer-actions').css('opacity', 1);
                    $loader.remove();
                }
            };

            $('#nova-image-viewer-regenerate').on('click', () => triggerRegenerate());
            $('#nova-image-viewer-edit-confirm').on('click', () => {
                const newText = $('#nova-image-viewer-prompt-input').val().trim();
                if (!newText) return toastr.warning('Промпт не может быть пустым');
                triggerRegenerate(newText);
            });
        };

        renderViewer();
    }
    


    function formatPostText(text) {
        if (!text) return '';
        
        // Parse markdown images (e.g., for stickers)
        let formatted = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            return `<img src="${url}" alt="${alt}" style="max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 4px; display: block; object-fit: contain;">`;
        });
        
        // Find @handle
        formatted = formatted.replace(/@([a-zA-Z0-9_]+)/g, (match, handle) => {
            return `<span class="nova-clickable-handle" data-handle="${match}" style="color: var(--nova-accent); cursor: pointer;" title="Открыть профиль">${match}</span>`;
        });

        return formatted;
    }

    // ---- Персоны юзера ----
    //
    // Раньше профиль юзера в соцсети жил под одним фиксированным ключом
    // charProfiles['user_persona'] — общим на ВСЕ персоны Таверны сразу. Смена
    // персоны в Таверне никак его не трогала: один и тот же ник/аватар/био
    // висел везде. Теперь у каждой персоны Таверны — свой профиль, а сами
    // профили (name/handle/desc/style/avatar_desc/custom_avatar/banner)
    // по-прежнему живут в charProfiles, просто под id персоны из NOVA.personas,
    // а не под общей строкой — это сохраняет весь механизм сохранения/аватарки/
    // шапки в renderCharsTab нетронутым.

    /** Живой ID аватарки активной СЕЙЧАС в Таверне персоны (не снимок). */
    function currentPersonaAvatarId() {
        return typeof livePersonaAvatarId === 'string' ? livePersonaAvatarId : '';
    }

    /** Список сохранённых NOVA-персон, с миграцией старого единственного профиля один раз. */
    function getPersonasList() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return [];
        if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};
        const store = ctx.extensionSettings.NOVA;
        if (!Array.isArray(store.personas)) store.personas = [];
        if (!store.charProfiles) store.charProfiles = {};

        if (store.personas.length === 0 && store.charProfiles['user_persona']) {
            const id = `persona_${Date.now()}`;
            store.charProfiles[id] = store.charProfiles['user_persona'];
            delete store.charProfiles['user_persona'];
            store.personas.push({ id, avatarId: currentPersonaAvatarId() || null });
        }
        return store.personas;
    }

    /**
     * Активная персона: явный пин (выбрана руками) важнее автоопределения,
     * иначе — та, что привязана к персоне, реально выбранной сейчас в Таверне.
     * Ничего не найдено — вызывающий код сам подставит live-имя из Таверны,
     * как и раньше, до появления списка персон.
     */
    function getActivePersonaEntry() {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const list = getPersonasList();
        const pinnedId = ctx?.extensionSettings?.NOVA?.activePersonaId;
        if (pinnedId) {
            const pinned = list.find(p => p.id === pinnedId);
            if (pinned) return pinned;
        }
        const avatarId = currentPersonaAvatarId();
        return (avatarId && list.find(p => p.avatarId === avatarId)) || null;
    }

    /** Как getActivePersonaEntry, но заводит персону под текущую живую Таверна-персону, если её ещё нет. */
    function ensureActivePersonaId() {
        const existing = getActivePersonaEntry();
        if (existing) return existing.id;
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.extensionSettings) return null;
        const list = getPersonasList();
        const id = `persona_${Date.now()}`;
        list.push({ id, avatarId: currentPersonaAvatarId() || null });
        return id;
    }

    // Collect all active NPCs and characters (с учётом отключённых персонажей)
    function getActiveProfiles() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const active = [];

        if (stContext) {
            const charProfiles = stContext.extensionSettings?.NOVA?.charProfiles || {};
            const { characters, groups, characterId, groupId } = stContext;

            // User Persona
            const personaName = stContext.name1 || 'User';
            const personaAvatarUrl = currentPersonaAvatarId();
            const activePersona = getActivePersonaEntry();
            if (personaName) {
                const genProfile = (activePersona && charProfiles[activePersona.id]) || {};
                let avatarUrl = personaAvatarUrl ? `/User Avatars/${personaAvatarUrl}` : '';
                if (genProfile.custom_avatar) avatarUrl = genProfile.custom_avatar;
                let h = genProfile.handle || `@${transliterate(personaName || 'user')}`;
                if (!h.startsWith('@')) h = '@' + h;
                active.push({
                    type: 'char',
                    isUser: true,
                    name: genProfile.name || personaName,
                    // Имя, под которым персона известна в самом чате. В соцсети профиль
                    // можно переименовать во что угодно, но ролеплею нужно имя из Таверны —
                    // иначе расшифровка ника указывает на кого-то, кого в чате не существует
                    chatName: personaName,
                    handle: h,
                    avatar: avatarUrl,
                    banner: genProfile.banner || null,
                    desc: genProfile.desc,
                    style: genProfile.style
                });
            }

            if (groupId && groups) {
                const group = groups.find(g => g.id === groupId || String(g.id) === String(groupId));
                if (group && group.members) {
                    group.members.forEach(memberId => {
                        const char = characters.find(c => c.avatar === memberId || String(c.id) === String(memberId));
                        if (char && !disabledGroupChars.has(String(memberId))) {
                            const genProfile = charProfiles[char.avatar] || {};
                            let avatarUrl = char.avatar ? `/characters/${char.avatar}` : '';
                            if (genProfile.custom_avatar) avatarUrl = genProfile.custom_avatar;
                            let h = genProfile.handle || `@${transliterate(char.name || 'user')}`;
                            if (!h.startsWith('@')) h = '@' + h;
                            active.push({ type: 'char', name: genProfile.name || char.name, chatName: char.name, handle: h, avatar: avatarUrl, banner: genProfile.banner || null, desc: genProfile.desc, style: genProfile.style });
                        }
                    });
                }
            } else if (characterId !== undefined && characters && characters[characterId]) {
                const char = characters[characterId];
                if (!disabledGroupChars.has(String(char.avatar))) {
                    const genProfile = charProfiles[char.avatar] || {};
                    let avatarUrl = char.avatar ? `/characters/${char.avatar}` : '';
                    if (genProfile.custom_avatar) avatarUrl = genProfile.custom_avatar;
                    let h = genProfile.handle || `@${transliterate(char.name || 'user')}`;
                    if (!h.startsWith('@')) h = '@' + h;
                    active.push({ type: 'char', name: genProfile.name || char.name, chatName: char.name, handle: h, avatar: avatarUrl, banner: genProfile.banner || null, desc: genProfile.desc, style: genProfile.style });
                }
            }
        }

        // 2. Default Folder NPCs
        if (defaultFolder.active) {
            defaultFolder.npcs.filter(n => n.active).forEach(n => {
                active.push({ type: 'npc', name: n.name, handle: n.handle, avatar: n.avatar, banner: n.banner || null, desc: n.desc, style: n.style, color: n.color });
            });
        }

        const currentChatId = stContext ? stContext.chatId : null;

        // 3. Custom Folders (only active ones for the current chat, or global ones без привязки)
        customFolders.filter(f => f.active && (!f.chatIds || f.chatIds.includes(currentChatId))).forEach(f => {
            f.npcs.filter(n => n.active).forEach(n => {
                active.push({ type: 'npc', name: n.name, handle: n.handle, avatar: n.avatar, banner: n.banner || null, desc: n.desc, style: n.style, color: n.color });
            });
        });

        return active;
    }

    // Нормализация хэндла: убираем @, пробелы и регистр
    function normHandle(value) {
        return String(value ?? '').trim().toLowerCase().replace(/^@+/, '');
    }

    // Ищем профиль автора по хэндлу (или имени, если ИИ подставил имя вместо хэндла)
    function resolveAuthorProfile(rawHandle, activeProfiles, rawName) {
        const profiles = activeProfiles || [];
        const handleKey = normHandle(rawHandle);
        const nameKey = normHandle(rawName);

        if (handleKey === 'user') {
            return profiles.find(ap => ap.isUser) || { name: 'Вы', handle: '@user', avatar: '', color: '#1da1f2' };
        }

        let profile = null;
        if (handleKey) {
            profile = profiles.find(ap => normHandle(ap.handle) === handleKey)
                || profiles.find(ap => normHandle(ap.name) === handleKey);
        }
        if (!profile && nameKey) {
            profile = profiles.find(ap => normHandle(ap.name) === nameKey)
                || profiles.find(ap => normHandle(ap.handle) === nameKey);
        }
        if (profile) return profile;

        const fallbackHandle = handleKey ? '@' + handleKey : '@unknown';
        const fallbackName = (rawName && String(rawName).trim()) || (handleKey ? fallbackHandle : 'Unknown');
        return { name: fallbackName, handle: fallbackHandle, avatar: '', color: '#333' };
    }

    // Рекурсивно проставляет имя/хэндл/аватар/цвет для веток ответов ЛЮБОЙ вложенности
    function mapRepliesRecursive(rawReplies, activeProfiles, depth = 0) {
        if (!Array.isArray(rawReplies) || depth > 12) return [];
        const userHandle = activeProfiles.find(p => p.isUser)?.handle;
        return rawReplies
            .filter(r => r && typeof r === 'object')
            .filter(r => {
                // Модель периодически пишет реплаи от лица игрока, несмотря на запрет в промпте.
                // Отсекаем здесь: в ветке ответов юзер говорит только сам, руками.
                if (!userHandle) return true;
                const author = r.author_handle ?? r.authorHandle ?? r.handle;
                if (!author || normHandle(author) !== normHandle(userHandle)) return true;
                console.warn('[NOVA] Отброшен ответ, написанный от лица игрока:', r.text);
                return false;
            })
            .map(r => {
                const prof = resolveAuthorProfile(r.author_handle ?? r.authorHandle ?? r.handle, activeProfiles, r.name);
                return {
                    ...r,
                    handle: prof.handle,
                    name: prof.name,
                    avatar: prof.avatar || '',
                    color: prof.color || '#333',
                    text: r.text || '',
                    replies: mapRepliesRecursive(r.replies, activeProfiles, depth + 1),
                    // Чужой путь к картинке из контекста чата — см. комментарий в generateFeed
                    image: undefined,
                };
            });
    }

    async function getChatContext() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext || !stContext.chat) return "Нет контекста.";

        const settings = stContext.extensionSettings?.NOVA || {};
        const depth = parseInt($('#nova-context-size').val()) || 50;
        const powerUser = stContext.powerUserSettings || {};
        let contextParts = [];

        // 1. Persona (User)
        if (settings.include_persona !== false) {
            // Персоны живут в power_user, а не в extensionSettings и не в самом контексте.
            // persona_description — описание ТЕКУЩЕЙ персоны, остальное на случай, если оно пустое.
            const desc = powerUser.persona_description
                || powerUser.persona_descriptions?.[powerUser.default_persona]?.description
                || '';
            const name = stContext.name1 || 'Персона';
            if (desc) {
                contextParts.push(`USER PERSONA — «${name}» (описание самого игрока/пользователя):\n${desc}`);
            }
        }

        // 2. Character Cards
        if (settings.include_char_card !== false) {
            const { characters, characterId, groupId, groups } = stContext;
            let activeChars = [];
            if (groupId && groups) {
                const group = groups.find(g => g.id === groupId);
                if (group?.members) {
                    activeChars = group.members.map(m => characters.find(c => c.avatar === m)).filter(Boolean);
                }
            } else if (characterId !== undefined && characters[characterId]) {
                activeChars = [characters[characterId]];
            }

            activeChars.forEach(char => {
                const parts = [];
                if (char.description) parts.push(`Описание: ${char.description}`);
                if (char.personality) parts.push(`Личность: ${char.personality}`);
                if (char.scenario) parts.push(`Сценарий: ${char.scenario}`);
                if (char.mes_example) parts.push(`Примеры реплик: ${char.mes_example}`);
                if (parts.length > 0) {
                    contextParts.push(`CHARACTER CARD — «${char.name}» (персонаж):\n${parts.join('\n')}`);
                }
            });
        }

        // 3. Lorebooks (World Info)
        if (settings.include_lorebooks !== false && typeof stContext.getWorldInfoPrompt === 'function') {
            try {
                // Формат как в script.js: строки «имя: сообщение», новые первыми.
                // isDryRun = true — только читаем, без событий и без сдвига таймеров у записей.
                const chatForWI = stContext.chat
                    .slice(-depth)
                    .map(m => `${m.name}: ${m.mes}`)
                    .reverse();
                const wi = await stContext.getWorldInfoPrompt(chatForWI, stContext.maxContext, true);
                const worldInfoString = String(wi?.worldInfoString || '').trim();
                if (worldInfoString) {
                    contextParts.push(`LORE / WORLD INFO (лор и мировая информация):\n${worldInfoString}`);
                }
            } catch (e) {
                console.warn('[NOVA] Не удалось собрать World Info', e);
            }
        }

        // 4. Авторские заметки — и общая для чата, и привязанная к персонажу
        if (settings.include_author_note !== false) {
            const notes = [];

            const chatNote = String(stContext.chatMetadata?.note_prompt || '').trim();
            if (chatNote) notes.push(chatNote);

            const charAvatar = stContext.characters?.[stContext.characterId]?.avatar;
            if (charAvatar) {
                const charaKey = charAvatar.replace(/\.[^/.]+$/, '');
                const charaNote = stContext.extensionSettings?.note?.chara?.find(n => n?.name === charaKey);
                const charaPrompt = String(charaNote?.prompt || '').trim();
                if (charaPrompt && !notes.includes(charaPrompt)) notes.push(charaPrompt);
            }

            if (notes.length) {
                contextParts.push(`AUTHOR'S NOTE (указания автора по текущей сцене — учитывай их):\n${notes.join('\n\n')}`);
            }
        }

        // 5. Recent Chat History
        const recent = stContext.chat.slice(-depth).map(m => `${m.name}: ${m.mes}`).join('\n');
        contextParts.push(`ИСТОРИЯ ЧАТА (последние ${depth} сообщений):\n${recent || "Нет сообщений в чате."}`);

        return contextParts.join('\n\n---\n\n');
    }

    /**
     * Единственная точка правды по видимости плавающих кнопок ленты.
     * Раньше их дёргали и переключение вкладок, и renderFeed — а renderFeed
     * вызывается откуда угодно (синхронизация, приход ЛС, сохранение ленты),
     * и кнопки всплывали поверх «Памяти» и остальных вкладок.
     */
    function updateFeedFabs() {
        const $fabs = $('#nova-feed-fabs');
        // stop(true, true) добивает предыдущую анимацию: без него быстрые
        // переключения вкладок оставляли кнопки залипшими на полпути
        $fabs.stop(true, true);
        if ($('#nova-view-feed').hasClass('active') && !feedSelectMode) {
            $fabs.fadeIn(200);
        } else {
            $fabs.fadeOut(200);
        }
    }

    function renderFeed() {
        syncSummaryMarkers();
        const $container = $('#nova-feed-container');
        $container.empty();

        if (feedSelectMode) {
            $('#nova-feed-cancel-select-btn').show();
            $('#nova-feed-confirm-delete-btn').show().text(`Удалить (${selectedFeedPosts.size})`);
            $('#nova-feed-delete-btn').hide();
        } else {
            $('#nova-feed-cancel-select-btn').hide();
            $('#nova-feed-confirm-delete-btn').hide();
            $('#nova-feed-delete-btn').show();
        }
        updateFeedFabs();

        if (feedPosts.length === 0) {
            $container.append('<div class="nova-post" style="justify-content: center; padding: 32px; color: var(--nova-text-muted);">Лента ожидает постов...</div>');
            return;
        }

        const activeProfiles = getActiveProfiles();
        const userProfile = activeProfiles.find(ap => ap.isUser);

        const patchProfile = (item) => {
            if (userProfile && item.handle && item.handle.toLowerCase() === userProfile.handle.toLowerCase()) {
                item.avatar = userProfile.avatar;
                item.name = userProfile.name;
            }
        };

        feedPosts.forEach(post => {
            patchProfile(post);
            if (post.replies) {
                const patchReplies = (replies) => {
                    replies.forEach(r => {
                        patchProfile(r);
                        if (r.replies) patchReplies(r.replies);
                    });
                };
                patchReplies(post.replies);
            }
        });

        feedPosts.forEach((post, index) => {
            const avatarHtml = post.avatar 
                ? `<img src="${post.avatar}" class="nova-profile-avatar nova-clickable-profile" data-handle="${post.handle}" onerror="this.style.display='none'">` 
                : `<div class="nova-profile-avatar nova-clickable-profile" data-handle="${post.handle}" style="background-color: ${post.color || '#333'}; color: white; font-weight: bold; font-size: 18px;">${(post.name || '?').charAt(0).toUpperCase()}</div>`;
            
            const repliesCount = countRepliesDeep(post.replies);

            const checkboxHtml = feedSelectMode 
                ? `<div style="display: flex; align-items: center; justify-content: center; width: 48px;"><input type="checkbox" class="nova-feed-checkbox" data-index="${index}" ${selectedFeedPosts.has(index) ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;"></div>`
                : '';

            $container.append(renderContextMarkers(post));
            
            const html = `
                <div class="nova-post nova-feed-post nova-long-pressable" data-item-type="post" data-index="${index}" style="cursor: pointer; transition: background 0.2s; ${feedSelectMode ? 'padding-left: 0;' : ''}">
                    ${checkboxHtml}
                    ${avatarHtml}
                    <div class="nova-post-content">
                        <div class="nova-post-header">
                            <div class="nova-post-name nova-clickable-profile" data-handle="${post.handle}">${post.name}</div>
                            <div class="nova-post-handle nova-clickable-profile" data-handle="${post.handle}">${post.handle}</div>
                            <div class="nova-post-time">· ${describePostAge(post)}</div>
                        </div>
                        <div class="nova-post-text">${formatPostText(post.text)}</div>
                        ${renderAttachedImage({...post, type: 'post', feedIndex: index})}
                        ${renderMusicShare(post)}
                        <div class="nova-post-stats">
                            <span title="Ответы"><i class="fa-regular fa-comment"></i> ${repliesCount}</span>
                            <span title="Репосты"><i class="fa-solid fa-retweet"></i> ${post.retweets || 0}</span>
                            <span title="Лайки"><i class="fa-regular fa-heart"></i> ${post.likes || 0}</span>
                        </div>
                    </div>
                </div>
            `;
            $container.append(html);
        });

        $('.nova-feed-post').on('click', function(e) {
            if ($(e.target).closest('.nova-clickable-profile').length > 0) return;
            if (feedSelectMode) {
                const idx = $(this).data('index');
                if (e.target.type !== 'checkbox') {
                    const $cb = $(this).find('.nova-feed-checkbox');
                    $cb.prop('checked', !$cb.prop('checked')).trigger('change');
                }
            } else {
                openSinglePost($(this).data('index'));
            }
        });

        let lastCheckedFeedIndex = null;
        $('.nova-feed-checkbox').on('change', function() {
            const currentIndex = $(this).data('index');
            
            if (this.checked) {
                if (lastCheckedFeedIndex !== null && lastCheckedFeedIndex !== currentIndex) {
                    const minIdx = Math.min(lastCheckedFeedIndex, currentIndex);
                    const maxIdx = Math.max(lastCheckedFeedIndex, currentIndex);
                    
                    $('.nova-feed-checkbox').each(function() {
                        const idx = $(this).data('index');
                        if (idx >= minIdx && idx <= maxIdx) {
                            $(this).prop('checked', true);
                            selectedFeedPosts.add(idx);
                        }
                    });
                } else {
                    selectedFeedPosts.add(currentIndex);
                }
                lastCheckedFeedIndex = currentIndex;
            } else {
                lastCheckedFeedIndex = null;
                selectedFeedPosts.delete(currentIndex);
            }
            $('#nova-feed-confirm-delete-btn').text(`Удалить (${selectedFeedPosts.size})`);
        });
    }

    function openSinglePost(index) {
        const post = feedPosts[index];
        if (!post) return;

        // Открытие ДРУГОГО поста сбрасывает выбор — иначе плашка «Удалить (3)»
        // могла бы выжить из прошлого треда и удалить не то
        if (currentSinglePostIndex !== index) {
            replySelectMode = false;
            selectedReplyKeys.clear();
        }
        currentSinglePostIndex = index;

        if (replySelectMode) {
            $('#nova-reply-cancel-select-btn').show();
            $('#nova-reply-confirm-delete-btn').show().text(`Удалить (${selectedReplyKeys.size})`);
            $('#nova-reply-select-mode-btn').hide();
        } else {
            $('#nova-reply-cancel-select-btn').hide();
            $('#nova-reply-confirm-delete-btn').hide();
            $('#nova-reply-select-mode-btn').show();
        }

        const avatarHtml = post.avatar
            ? `<img src="${post.avatar}" class="nova-profile-avatar nova-clickable-profile" data-handle="${post.handle}" onerror="this.style.display='none'">` 
            : `<div class="nova-profile-avatar nova-clickable-profile" data-handle="${post.handle}" style="background-color: ${post.color || '#333'}; color: white; font-weight: bold; font-size: 18px;">${(post.name || '?').charAt(0).toUpperCase()}</div>`;
        
        const repliesCount = countRepliesDeep(post.replies);
        if (!post.replies) post.replies = [];
        let replyTarget = { handle: post.handle, text: post.text, targetArray: post.replies };

        const mainHtml = `
            <div class="nova-post nova-long-pressable" data-item-type="main-post" data-index="${index}" style="border: none; flex-direction: column; gap: 12px; padding: 16px; padding-bottom: 0;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    ${avatarHtml.replace('class="nova-profile-avatar"', 'class="nova-profile-avatar" style="width: 48px; height: 48px; min-width: 48px; font-size: 24px;"')}
                    <div style="display: flex; flex-direction: column;">
                        <span class="nova-clickable-profile" data-handle="${post.handle}" style="font-weight: 800; font-size: 16px; color: var(--nova-text);">${post.name}</span>
                        <span class="nova-clickable-profile" data-handle="${post.handle}" style="color: var(--nova-text-muted); font-size: 15px;">${post.handle}</span>
                    </div>
                </div>
                <div class="nova-post-text" style="font-size: 18px; line-height: 1.5; margin: 4px 0;">${formatPostText(post.text)}</div>
                ${renderAttachedImage({...post, type: 'post', feedIndex: index})}
                ${renderMusicShare(post)}
                <div class="nova-post-stats" style="display: flex; gap: 20px; padding: 16px 0; margin: 0; font-size: 15px; color: var(--nova-text-muted); border-top: 1px solid var(--nova-border);">
                    <span title="Ответить" class="nova-action-reply" data-handle="${post.handle}" data-text="${post.text.replace(/"/g, '&quot;')}" style="display: flex; align-items: center; gap: 6px; cursor: pointer;"><i class="fa-regular fa-comment"></i> <b style="color: var(--nova-text);">${repliesCount}</b></span>
                    <span title="Ретвиты" style="display: flex; align-items: center; gap: 6px;"><i class="fa-solid fa-retweet"></i> <b style="color: var(--nova-text);">${post.retweets || 0}</b></span>
                    <span title="Лайки" style="display: flex; align-items: center; gap: 6px;"><i class="fa-regular fa-heart"></i> <b style="color: var(--nova-text);">${post.likes || 0}</b></span>
                </div>
            </div>
        `;
        $('#nova-single-post-main').html(mainHtml);

        const $repliesContainer = $('#nova-single-post-replies');
        $repliesContainer.empty();

        function renderRepliesList(repliesArray, $container, isNested = false, parentPath = []) {
            if (!repliesArray || repliesArray.length === 0) return;
            
            repliesArray.forEach((reply, i) => {
                const currentPath = [...parentPath, i];
                if (!reply.replies) reply.replies = [];
                const rAvatarHtml = reply.avatar 
                    ? `<img src="${reply.avatar}" class="nova-profile-avatar nova-clickable-profile" data-handle="${reply.handle}" onerror="this.style.display='none'" style="width: 32px; height: 32px; min-width: 32px;">` 
                    : `<div class="nova-profile-avatar nova-clickable-profile" data-handle="${reply.handle}" style="width: 32px; height: 32px; min-width: 32px; background-color: ${reply.color || '#333'}; color: white; font-weight: bold; font-size: 14px;">${(reply.name || '?').charAt(0).toUpperCase()}</div>`;
                
                const hasReplies = reply.replies && reply.replies.length > 0;
                const replyKey = currentPath.join(',');
                const checkboxHtml = replySelectMode
                    ? `<div style="display: flex; align-items: center; justify-content: center; width: 24px; flex-shrink: 0;"><input type="checkbox" class="nova-reply-checkbox" data-key="${replyKey}" ${selectedReplyKeys.has(replyKey) ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;"></div>`
                    : '';
                const $replyHtml = $(`
                    <div class="nova-reply-wrapper nova-long-pressable" data-item-type="reply" data-top-index="${index}" data-reply-path="${currentPath.join(',')}" style="position: relative; ${isNested ? 'padding-top: 12px;' : 'padding: 12px 16px; border-bottom: 1px solid var(--nova-border);'}">
                        ${!isNested && hasReplies ? `<div style="position: absolute; top: 44px; bottom: 32px; left: 31px; width: 2px; background: var(--nova-border); z-index: 0;"></div>` : ''}
                        <div class="nova-reply-main" style="display: flex; gap: 12px; position: relative; z-index: 1;">
                            ${checkboxHtml}
                            <div class="nova-reply-avatar-col" style="width: 32px; flex-shrink: 0;">
                                ${rAvatarHtml}
                            </div>
                            <div class="nova-reply-content" style="flex: 1; font-size: 14px;">
                                <div class="nova-reply-header" style="display: flex; align-items: baseline; gap: 6px;">
                                    <span class="nova-clickable-profile" data-handle="${reply.handle}" style="font-weight: bold; color: var(--nova-text);">${reply.name}</span>
                                    <span class="nova-clickable-profile" data-handle="${reply.handle}" style="color: var(--nova-text-muted); font-size: 13px;">${reply.handle}</span>
                                </div>
                                <div class="nova-reply-text" style="color: var(--nova-text); margin-top: 4px;">${formatPostText(reply.text)}</div>
                                ${renderAttachedImage({...reply, type: 'reply', feedIndex: index, replyPath: currentPath.join(',')})}
                                ${renderMusicShare(reply)}
                                <div class="nova-reply-actions" style="margin-top: 8px; display: flex; gap: 16px; color: var(--nova-text-muted);">
                                    <span class="nova-action-reply-to-comment" style="cursor: pointer; display: flex; align-items: center; gap: 6px;"><i class="fa-solid fa-reply"></i> Ответить</span>
                                    ${hasReplies ? `<span class="nova-action-toggle-thread" style="cursor: pointer; display: flex; align-items: center; gap: 6px;"><i class="fa-solid fa-chevron-up"></i> Свернуть</span>` : ''}
                                </div>
                            </div>
                        </div>
                        <div class="nova-reply-thread-container" style="${isNested ? '' : 'margin-top: 0;'}"></div>
                    </div>
                `);

                $replyHtml.find('.nova-action-reply-to-comment').on('click', function(e) {
                    e.stopPropagation();
                    replyTarget = {
                        handle: reply.handle,
                        text: reply.text,
                        targetArray: reply.replies
                    };
                    $('#nova-single-post-reply-input').attr('placeholder', `Ответить ${replyTarget.handle}...`).focus();
                });

                // В режиме выбора тап по телу ответа переключает его чекбокс — как
                // у постов в основной ленте. Вне режима выбора клик ничего не делает.
                $replyHtml.find('.nova-reply-main').on('click', function(e) {
                    if (!replySelectMode) return;
                    if ($(e.target).closest('.nova-action-reply-to-comment, .nova-action-toggle-thread, .nova-clickable-profile').length) return;
                    if (e.target.type === 'checkbox') return;
                    const $cb = $(this).find('.nova-reply-checkbox');
                    $cb.prop('checked', !$cb.prop('checked')).trigger('change');
                });

                $replyHtml.find('.nova-reply-checkbox').on('change', function() {
                    const key = String($(this).attr('data-key') || '');
                    if (this.checked) selectedReplyKeys.add(key);
                    else selectedReplyKeys.delete(key);
                    $('#nova-reply-confirm-delete-btn').text(`Удалить (${selectedReplyKeys.size})`);
                });

                $replyHtml.find('.nova-action-toggle-thread').on('click', function(e) {
                    e.stopPropagation();
                    const $container = $replyHtml.find('.nova-reply-thread-container').first();
                    const $text = $(this);
                    $container.slideToggle(200, function() {
                        if ($container.is(':visible')) {
                            $text.html('<i class="fa-solid fa-chevron-up"></i> Свернуть');
                        } else {
                            $text.html('<i class="fa-solid fa-chevron-down"></i> Развернуть');
                        }
                    });
                });

                if (reply.replies && reply.replies.length > 0) {
                    const $threadContainer = $replyHtml.find('.nova-reply-thread-container');
                    $threadContainer.addClass('nova-reply-thread');
                    // Путь обязателен: без него вложенные ответы считали себя веткой первого
                    // уровня, и удаление сносило чужой тред с тем же индексом
                    renderRepliesList(reply.replies, $threadContainer, true, currentPath);
                }

                $container.append($replyHtml);
            });
        }

        if (repliesCount === 0) {
            $repliesContainer.append('<div style="padding: 32px; text-align: center; color: var(--nova-text-muted);">Здесь пока нет ответов. Будьте первыми!</div>');
        } else {
            renderRepliesList(post.replies, $repliesContainer);
        }

        $('.nova-action-reply').on('click', function() {
            if (!post.replies) post.replies = [];
            replyTarget = {
                handle: post.handle,
                text: post.text,
                targetArray: post.replies
            };
            $('#nova-single-post-reply-input').attr('placeholder', `Ответить ${replyTarget.handle}...`).focus();
        });

        $('#nova-single-post-reply-btn').off('click').on('click', async () => {
            const text = $('#nova-single-post-reply-input').val().trim();
            if (!text) return;
            
            if (!replyTarget.targetArray) replyTarget.targetArray = [];
            
            const stContext = SillyTavern.getContext();
            const activeProfiles = getActiveProfiles();
            const userProfile = activeProfiles.find(ap => ap.isUser) || { name: stContext.name1 || 'Вы', handle: '@user', avatar: currentPersonaAvatarId() ? `/User Avatars/${currentPersonaAvatarId()}` : '', color: '#1da1f2' };
            
            // Держим ссылку на реплай юзера: ответы ИИ должны стать ЕГО веткой
            const userReply = {
                name: userProfile.name,
                handle: userProfile.handle,
                text: text,
                avatar: userProfile.avatar,
                color: userProfile.color || 'var(--nova-accent)',
                replies: []
            };
            replyTarget.targetArray.push(userReply);
            
            saveFeed();
            $('#nova-single-post-reply-input').val('');
            openSinglePost(feedPosts.indexOf(post));
            renderFeed();

            const $loader = $(`<div class="nova-reply"><div class="nova-typing-dots"><div class="nova-typing-dot"></div><div class="nova-typing-dot"></div><div class="nova-typing-dot"></div></div></div>`);
            $('#nova-single-post-replies').append($loader);

            try {
                const chatContext = await getChatContext();
                const profilesInfo = activeProfiles.map(p => {
                    if (p.type === 'npc') return `- ${p.name} (${p.handle}): ${p.desc} | Стиль: ${p.style}`;
                    if (p.isUser) return `- ${p.name} (${p.handle}): [ИГРОК / ЮЗЕР] КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО генерировать посты или сообщения от этого лица.`;
                    return `- ${p.name} (${p.handle}): Персонаж из чата.`;
                }).join('\n');
                
                // Весь этот батч — реакции НА конкретный реплай юзера в треде, не обычная
                // лента вперемешку с чужими темами: строгий фильтр релевантности тут не нужен
                const prompt = NovaPrompts.generateFeedReply(profilesInfo, chatContext, replyTarget.text, text, replyTarget.handle, userProfile.handle, buildRelationshipInstruction(userProfile.handle, 'feed-reaction') + buildMusicInstruction());
                let result = await callAI(prompt);
                let parsed = parseJSONFromText(result);
                if (parsed && Array.isArray(parsed.posts) && parsed.posts.length > 0) {
                    // Один и тот же маппинг для всех уровней вложенности
                    const mappedPosts = mapRepliesRecursive(parsed.posts, activeProfiles).filter(p => p.text);
                    if (mappedPosts.length === 0) throw new Error("В ответе ИИ нет текста");

                    // Тег симпатии — тем же проходом, что и у обычной ленты/ЛС. Раньше эта
                    // ветка вообще не вызывала absorbRelationshipTag, и ответы в тредах
                    // никогда не двигали симпатию, даже если модель честно прислала тег
                    const flatReplies = [];
                    const collectReplies = list => (list || []).forEach(p => {
                        flatReplies.push(p);
                        if (p.replies) collectReplies(p.replies);
                    });
                    collectReplies(mappedPosts);
                    flatReplies.forEach(absorbRelationshipTag);
                    flatReplies.forEach(absorbMusicTag);

                    // Всё сгенерированное — ветка ПОД реплаем юзера. Раньше первый ответ
                    // становился его соседом, а остальные уезжали в корень поста, из-за чего
                    // ветка выглядела как разговор с первым отвечающим, а не с юзером.
                    userReply.replies.push(...mappedPosts);

                    saveFeed();
                    openSinglePost(feedPosts.indexOf(post));
                    renderFeed();
                }
            } catch (e) {
                console.error(e);
                toastr.error("Ошибка при генерации ответа: " + describeApiError(e));
                const failedIdx = replyTarget.targetArray.indexOf(userReply);
                if (failedIdx !== -1) replyTarget.targetArray.splice(failedIdx, 1);
                saveFeed();
                $('#nova-single-post-reply-input').val(text);
                openSinglePost(feedPosts.indexOf(post));
                renderFeed();
            } finally {
                $loader.remove();
            }
        });

        const $replyAvatar = $('#nova-single-post-reply-avatar');
        if ($replyAvatar.length) {
            const stContext = SillyTavern.getContext();
            const activeProfiles = getActiveProfiles();
            const userProfile = activeProfiles.find(ap => ap.isUser) || { name: stContext.name1 || 'Вы', color: '#1da1f2' };
            if (userProfile.avatar) {
                $replyAvatar.replaceWith(`<img id="nova-single-post-reply-avatar" src="${userProfile.avatar}" class="nova-profile-avatar" style="width: 32px; height: 32px; min-width: 32px; border-radius: 50%; object-fit: cover;">`);
            } else {
                $replyAvatar.replaceWith(`<div id="nova-single-post-reply-avatar" class="nova-profile-avatar" style="width: 32px; height: 32px; min-width: 32px; background-color: ${userProfile.color || '#1da1f2'}; color: white; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold; border-radius: 50%;">${(userProfile.name || '?').charAt(0).toUpperCase()}</div>`);
            }
        }

        $('#nova-view-single-post').addClass('active');
    }

    function updateUnreadBadge() {
        const totalUnread = dmThreads.reduce((sum, t) => sum + (t.unread || 0), 0);
        const $tab = $('.nova-nav-btn[data-target="dms"]');
        let $badge = $tab.find('.nova-unread-badge');
        
        if (totalUnread > 0) {
            if ($badge.length === 0) {
                $tab.append(`<div class="nova-unread-badge" style="position: absolute; top: -4px; right: -4px; background: var(--nova-accent); color: white; border-radius: 50%; min-width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; padding: 0 4px; pointer-events: none;">${totalUnread}</div>`);
            } else {
                $badge.text(totalUnread);
            }
        } else {
            $badge.remove();
        }
    }

    /** Тот же бейдж, что у непрочитанных ЛС, но на иконке «Отношения» — вместо тостов на каждую смену статуса. */
    function updateRelationshipBadge() {
        const count = getRelationshipSettings().unreadCount || 0;
        const $tab = $('.nova-nav-btn[data-target="relationships"]');
        let $badge = $tab.find('.nova-unread-badge');

        if (count > 0) {
            if ($badge.length === 0) {
                $tab.append(`<div class="nova-unread-badge" style="position: absolute; top: -4px; right: -4px; background: var(--nova-accent); color: white; border-radius: 50%; min-width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; padding: 0 4px; pointer-events: none;">${count}</div>`);
            } else {
                $badge.text(count);
            }
        } else {
            $badge.remove();
        }
    }

    function renderDMs() {
        refreshThreadProfiles();
        const $container = $('#nova-view-dms');
        $container.empty();
        $container.append(`
            <div style="padding: 16px; display: flex; justify-content: space-between; align-items: center;">
                <h2 style="margin-top:0; margin-bottom:0;">Сообщения</h2>
                <button id="nova-new-dm-btn" title="Написать сообщение" style="background: transparent; color: var(--nova-accent); border: none; cursor: pointer; font-size: 20px; transition: 0.2s;"><i class="fa-solid fa-pen-to-square"></i></button>
            </div>
            <div id="nova-dms-list"></div>
        `);
        
        $('#nova-new-dm-btn').off('click').on('click', () => {
            const $listContainer = $('#nova-new-dm-profiles-list');
            $listContainer.empty();
            $('#nova-new-dm-group-details').hide();
            $('#nova-new-group-name').val('');
            $('#nova-new-dm-create-group-btn').css('color', 'var(--nova-text)');
            
            const activeProfiles = getActiveProfiles().filter(p => !p.isUser);
            if (activeProfiles.length === 0) {
                $listContainer.append('<div style="color: var(--nova-text-muted); text-align: center; padding: 20px;">Нет доступных персонажей.</div>');
            } else {
                activeProfiles.forEach(p => {
                    const avatarHtml = p.avatar 
                        ? `<img src="${p.avatar}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">` 
                        : `<div style="width:48px;height:48px;border-radius:50%;background-color:${p.color || '#333'};color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:20px;">${(p.name || '?').charAt(0).toUpperCase()}</div>`;
                    
                    const phtml = `
                        <div class="nova-new-dm-profile-card" data-handle="${p.handle}" style="display:flex; gap:12px; align-items:center; padding:12px; border-radius:12px; background:var(--nova-surface-hover); cursor:pointer;">
                            <input type="checkbox" class="nova-new-group-checkbox" value="${p.handle}" style="display:none; width: 18px; height: 18px; accent-color: var(--nova-accent); cursor: pointer; flex-shrink: 0;">
                            ${avatarHtml}
                            <div>
                                <div style="font-weight:bold; font-size:15px;">${p.name}</div>
                                <div style="font-size:13px; color:var(--nova-text-muted);">${p.handle}</div>
                            </div>
                        </div>
                    `;
                    $listContainer.append(phtml);
                });
            }

            let isGroupMode = false;
            let newGroupAvatar = null; // data URL до создания, грузим на сервер только при подтверждении

            const resetNewGroupAvatar = () => {
                newGroupAvatar = null;
                $('#nova-new-group-avatar').html('<i class="fa-solid fa-camera"></i>').css('background-image', 'none');
            };
            resetNewGroupAvatar();

            $('#nova-new-group-avatar').off('click').on('click', () => $('#nova-new-group-avatar-input').trigger('click'));
            $('#nova-new-group-avatar-input').off('change').on('change', async function() {
                const file = this.files?.[0];
                this.value = '';
                if (!file) return;
                try {
                    newGroupAvatar = await compressImageFile(file, 512);
                    $('#nova-new-group-avatar').empty().css({
                        'background-image': `url("${newGroupAvatar}")`,
                        'background-size': 'cover',
                        'background-position': 'center',
                        'border-style': 'solid',
                    });
                } catch (e) {
                    console.error('[NOVA] Не удалось подготовить аватар группы', e);
                    toastr.error('Не удалось обработать изображение: ' + (e.message || ''));
                }
            });

            $('#nova-new-dm-create-group-btn').off('click').on('click', function() {
                isGroupMode = !isGroupMode;
                if (isGroupMode) {
                    $('#nova-new-dm-group-details').slideDown();
                    $('.nova-new-group-checkbox').show().prop('checked', false);
                    $(this).css('color', 'var(--nova-accent)');
                } else {
                    $('#nova-new-dm-group-details').slideUp();
                    $('.nova-new-group-checkbox').hide().prop('checked', false);
                    $(this).css('color', 'var(--nova-text)');
                }
            });

            $('#nova-new-group-cancel').off('click').on('click', function() {
                isGroupMode = false;
                $('#nova-new-dm-group-details').slideUp();
                $('.nova-new-group-checkbox').hide().prop('checked', false);
                $('#nova-new-dm-create-group-btn').css('color', 'var(--nova-text)');
                resetNewGroupAvatar();
            });

            $('#nova-new-group-confirm').off('click').on('click', async function() {
                const groupName = $('#nova-new-group-name').val().trim();
                const selectedHandles = [];
                $('.nova-new-group-checkbox:checked').each(function() {
                    selectedHandles.push($(this).val());
                });

                if (selectedHandles.length < 2) {
                    toastr.warning('Выберите хотя бы двух участников.');
                    return;
                }
                if (!groupName) {
                    toastr.warning('Введите название группы.');
                    return;
                }

                const $confirm = $(this).prop('disabled', true);
                let avatarPath = null;
                if (newGroupAvatar) {
                    try {
                        avatarPath = await uploadNovaImage(newGroupAvatar);
                    } catch (e) {
                        console.error('[NOVA] Не удалось загрузить аватар группы', e);
                        toastr.warning('Группа создана без аватара: не удалось загрузить изображение.');
                    }
                }
                $confirm.prop('disabled', false);

                $('#nova-view-new-dm-overlay').removeClass('active');

                const newThread = {
                    isGroup: true,
                    name: groupName,
                    handle: "@group_" + Math.random().toString(36).substr(2, 6),
                    avatar: avatarPath,
                    color: "#6c5ce7",
                    participants: selectedHandles,
                    unread: 0,
                    messages: []
                };
                resetNewGroupAvatar();
                dmThreads.unshift(newThread);
                saveFeed();
                renderDMs();
                openSingleDM(0);
            });
            
            $('.nova-new-dm-profile-card').off('click').on('click', function(e) {
                if (isGroupMode) {
                    if (!$(e.target).is('input[type="checkbox"]')) {
                        const $cb = $(this).find('input[type="checkbox"]');
                        $cb.prop('checked', !$cb.prop('checked'));
                    }
                    return;
                }

                const handle = $(this).data('handle');
                const profile = activeProfiles.find(p => p.handle === handle);
                if (!profile) return;
                
                $('#nova-view-new-dm-overlay').removeClass('active');
                
                let existingIndex = dmThreads.findIndex(t => !t.isGroup && t.handle.toLowerCase() === handle.toLowerCase());
                if (existingIndex !== -1) {
                    openSingleDM(existingIndex);
                } else {
                    const newThread = {
                        isGroup: false,
                        name: profile.name,
                        handle: profile.handle,
                        avatar: profile.avatar,
                        color: profile.color,
                        unread: 0,
                        messages: []
                    };
                    dmThreads.unshift(newThread);
                    saveFeed();
                    renderDMs();
                    openSingleDM(0);
                }
            });
            
            $('#nova-view-new-dm-overlay').addClass('active');
        });

        const $list = $('#nova-dms-list');
        if (dmThreads.length === 0) {
            $list.append('<div style="color: var(--nova-text-muted); text-align: center; padding: 40px;">Нет новых сообщений.</div>');
            updateUnreadBadge();
            return;
        }

        dmThreads.forEach((dm, index) => {
            const lastMsg = dm.messages.length > 0 ? dm.messages[dm.messages.length - 1] : { text: '', time: '' };
            const avatarHtml = renderThreadAvatar(dm, 48);

            const unreadBadge = dm.unread > 0 ? `<div style="background: var(--nova-accent); color: white; border-radius: 50%; min-width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; padding: 0 6px;">${dm.unread}</div>` : '';

            const html = `
                <div class="nova-dm-card" data-index="${index}" style="display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--nova-border); cursor: pointer; transition: background 0.2s; position: relative;">
                    ${avatarHtml}
                    <div style="flex: 1; overflow: hidden;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
                            <div class="nova-truncate" style="font-weight: 700; font-size: 15px; flex-shrink: 1;">${dm.name} <span style="font-size: 13px; font-weight: normal; color: var(--nova-text-muted);">${describeThreadSubtitle(dm)}</span></div>
                            <div style="font-size: 12px; color: var(--nova-text-muted); flex-shrink: 0;">${lastMsg.time || ''}</div>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                            <div class="nova-dm-text" style="color: var(--nova-text-muted); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80%;">
                                ${lastMsg.sender === 'user' ? 'Вы: ' : ''}${lastMsg.text}
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                ${unreadBadge}
                                <div class="nova-dm-card-delete-btn" style="color: var(--nova-text-muted); padding: 4px; border-radius: 50%; font-size: 12px; transition: color 0.2s;" title="Удалить чат">
                                    <i class="fa-solid fa-trash-can"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            $list.append(html);
        });

        $('.nova-dm-card').on('click', function(e) {
            if ($(e.target).closest('.nova-dm-card-delete-btn').length) {
                const idx = $(this).data('index');
                novaConfirm("Вы уверены, что хотите удалить весь чат? Это действие необратимо.", () => {
                    (dmThreads[idx]?.messages || []).forEach(revertRelationshipsDeep);
                    dmThreads.splice(idx, 1);
                    saveFeed();
                    renderDMs();
                });
                return;
            }
            openSingleDM($(this).data('index'));
        });

        $('.nova-dm-card-delete-btn').hover(function() {
            $(this).css('color', '#f44336');
        }, function() {
            $(this).css('color', 'var(--nova-text-muted)');
        });

        updateUnreadBadge();
    }
    
    // ─── Команды юзера в поле ввода ЛС ─────────────────────────────────────────
    // Юзер физически не может сам приложить сгенерированное фото или собрать
    // карточку трека/плейлиста — это либо настоящий вызов к картиночному
    // провайдеру, либо разметка, которую до сих пор строила только модель в
    // СВОИХ сообщениях. Команду разбираем ЛОКАЛЬНО, и само сообщение игрока тоже
    // собираем сами (buildUserCommandMessage) — так карточка гарантированно
    // выглядит как надо и появляется мгновенно. От модели тем же запросом нужны
    // только промпт для фото и реакция персонажа (userCommandInstructionBlock).
    //
    //   /фото <описание>
    //   /музыка <запрос>
    //   /плейлист "<название>" <трек1>, <трек2>, ...
    const NOVA_DM_COMMANDS = [
        { name: '/фото', icon: 'fa-camera', hint: 'описание', desc: 'Отправить своё фото' },
        { name: '/музыка', icon: 'fa-music', hint: 'исполнитель — трек', desc: 'Поделиться треком' },
        { name: '/плейлист', icon: 'fa-list', hint: '"название" трек1, трек2', desc: 'Собрать плейлист' },
    ];

    /**
     * Подсказка со списком команд. Показываем, пока набирают САМО имя команды
     * (в строке ещё нет пробела) — как только пошли аргументы, подсказка не нужна
     * и только закрывает переписку.
     */
    function renderDMCommandHints() {
        const $box = $('#nova-dm-command-hints');
        if (!$box.length) return;

        // Команда может быть не единственной строкой в поле — подпись до или после
        // неё идёт обычным текстом (см. обработчик отправки). Подсказку смотрим
        // только по ПОСЛЕДНЕЙ строке — той, что сейчас набирают.
        const valueLines = String($('#nova-single-dm-reply-input').val() || '').split('\n');
        const m = valueLines[valueLines.length - 1].match(/^\/(\S*)$/);
        if (!m) return hideDMCommandHints();

        const typed = m[1].toLowerCase();
        const matches = NOVA_DM_COMMANDS.filter(c => c.name.slice(1).toLowerCase().startsWith(typed));
        if (!matches.length) return hideDMCommandHints();

        $box.html(matches.map(c => `
            <button type="button" class="nova-command-hint" data-command="${escapeHtml(c.name)}">
                <i class="fa-solid ${c.icon}"></i>
                <span class="nova-command-hint-body">
                    <span class="nova-command-hint-top">
                        <span class="nova-command-hint-name">${escapeHtml(c.name)}</span>
                        <span class="nova-command-hint-arg">${escapeHtml(c.hint)}</span>
                    </span>
                    <span class="nova-command-hint-desc">${escapeHtml(c.desc)}</span>
                </span>
            </button>
        `).join(''));
        // Именно flex, а не .show(): тот подставил бы display:block и поломал
        // колоночную раскладку, заданную для .nova-command-hints в CSS
        $box.css('display', 'flex');
    }

    function hideDMCommandHints() {
        $('#nova-dm-command-hints').css('display', 'none').empty();
    }

    // Делегированные — поле ввода переживает перерисовку переписки (openSingleDM)
    $(document).on('input.novaCmdHints', '#nova-single-dm-reply-input', renderDMCommandHints);
    $(document).on('click.novaCmdHints', '.nova-command-hint', function() {
        // Подставляем только в ПОСЛЕДНЮЮ строку — остальные (подпись до команды)
        // остаются как есть. Пробел сразу: дальше идут аргументы, и подсказка
        // сама скроется (см. regexp выше).
        const $input = $('#nova-single-dm-reply-input');
        const valueLines = String($input.val() || '').split('\n');
        valueLines[valueLines.length - 1] = `${$(this).data('command')} `;
        $input.val(valueLines.join('\n')).trigger('focus');
        hideDMCommandHints();
    });
    $(document).on('keydown.novaCmdHints', '#nova-single-dm-reply-input', function(e) {
        if (e.key === 'Escape') hideDMCommandHints();
    });

    function parseUserDMCommand(raw) {
        const text = String(raw || '').trim();
        let m;

        if ((m = text.match(/^\/(?:фото|photo)\s+(.+)$/is))) {
            // raw — чтобы вернуть команду в поле ввода, если запрос упадёт
            return { type: 'photo', description: m[1].trim(), raw: text };
        }

        if ((m = text.match(/^\/(?:музыка|music)\s+(.+)$/is))) {
            return { type: 'music', tracks: [m[1].trim()], playlistName: '', raw: text };
        }

        // \b тут не годится: он опирается на ASCII \w и не видит границу между
        // кириллической буквой и пробелом — "плейлист " перед \b проваливался
        // целиком, ветка не срабатывала вообще ни на одном вводе
        if ((m = text.match(/^\/(?:плейлист|playlist)(?:\s+(.*))?$/is))) {
            // Группа необязательная (голое "/плейлист" без ничего) — тогда undefined
            let rest = (m[1] || '').trim();
            // "с названием" перед кавычками — необязательная связка для читаемости
            rest = rest.replace(/^с\s+названием\s*/i, '');

            let playlistName = '';
            const quoted = rest.match(/["'«»„“”]([^"'«»„“”]+)["'«»„“”]/);
            if (quoted) {
                playlistName = quoted[1].trim();
                rest = rest.slice(quoted.index + quoted[0].length);
            }
            // "с песнями"/"с треками" после названия — тоже необязательная связка
            rest = rest.replace(/^\s*с\s+(?:песнями|треками)\s*/i, '').replace(/^[:\-\s]+/, '');

            const tracks = rest.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
            if (!tracks.length) return null;
            return { type: 'playlist', tracks, playlistName, raw: text };
        }

        return null;
    }

    /**
     * Готовое сообщение игрока по команде. Строим САМИ, а не просим у модели:
     * названия треков должны попасть в карточку ровно теми, что игрок ввёл, и
     * сообщение обязано появиться в переписке сразу, не дожидаясь ответа модели.
     *
     * У фото промпта пока нет — его пишет модель тем же запросом
     * (user_photo_prompt, см. userCommandInstructionBlock). Пометка
     * awaitingCommandPhoto говорит generateDMResponseInner, в какое сообщение его
     * положить, а imagePending рисует спиннер на месте будущей картинки.
     */
    function buildUserCommandMessage(command) {
        const base = {
            text: '',
            sender: 'user',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        if (command.type === 'photo') {
            return { ...base, awaitingCommandPhoto: true, imagePending: true };
        }
        // Карточка сразу видна с тем, что ввёл игрок — не пустой слот, как у фото,
        // ждать тут особо нечего. Но названия он мог набрать вольно ("монеточка нет
        // монет" вместо точного "Монеточка - Нет монет"), а MoodTube ищет по
        // текстовому запросу — чем точнее строка, тем вернее найдётся нужный трек.
        // awaitingTrackCorrection помечает карточку на подмену, когда ответ модели
        // придёт (см. generateDMResponseInner) — recordSharedTracks зовём уже ТАМ,
        // с итоговыми названиями, а не с черновыми.
        return {
            ...base,
            musicShare: { tracks: command.tracks, note: '', playlistName: command.playlistName || '' },
            awaitingTrackCorrection: true,
        };
    }

    // Какой тред открыт сейчас — чтобы не тащить выбранную картинку в соседнюю переписку
    let openDMIndex = null;

    function openSingleDM(index) {
        const thread = dmThreads[index];
        if (!thread) return;

        if (openDMIndex !== index) {
            clearPendingImage('dm');
            openDMIndex = index;
        }

        thread.unread = 0;
        updateUnreadBadge();
        saveFeed();
        renderDMs();

        $('#nova-single-dm-name').text(thread.name);
        $('#nova-single-dm-handle').text(describeThreadSubtitle(thread));
        // Сравнение «этот ли тред открыт» раньше шло по тексту подписи — у групп он больше не хэндл
        $('#nova-view-single-dm').attr('data-thread-handle', thread.handle || '');

        // Тема красит весь экран переписки через CSS-переменные и даёт СВОЙ
        // фон-градиент — но только пока нет своей картинки-обоев, та в приоритете
        // всегда (см. ниже).
        const dmTheme = getDMTheme(thread.theme);
        applyDMThemeVars(dmTheme);

        // Обои чата — свои у каждого треда. Отдельный неподвижный слой позади
        // сообщений (не на самом скролл-контейнере — иначе картинка ездила бы вместе
        // с прокруткой), с лёгким затемнением, чтобы пузыри не терялись на пёстром фоне
        $('#nova-single-dm-wallpaper').css('background-image', thread.wallpaper
            ? `linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), url("${encodeURI(thread.wallpaper)}")`
            : (dmTheme.background || 'none'));

        // У группы аватар можно сменить — жмём по нему
        const $avatarBox = $('#nova-single-dm-avatar-container').html(renderThreadAvatar(thread, 40));
        $avatarBox.toggleClass('nova-avatar-editable', !!thread.isGroup)
            .attr('title', thread.isGroup ? 'Сменить аватар группы' : '');

        $avatarBox.off('click').on('click', () => {
            if (!thread.isGroup) return;
            $('#nova-group-avatar-input').trigger('click');
        });

        $('#nova-group-avatar-input').off('change').on('change', async function() {
            const file = this.files?.[0];
            this.value = '';
            if (!file || !thread.isGroup) return;
            try {
                const dataUrl = await compressImageFile(file, 512);
                thread.avatar = await uploadNovaImage(dataUrl);
                saveFeed();
                openSingleDM(index);
                renderDMs();
                toastr.success('Аватар группы обновлён');
            } catch (e) {
                console.error('[NOVA] Не удалось сменить аватар группы', e);
                toastr.error('Не удалось обновить аватар: ' + (e.message || ''));
            }
        });

        const $messagesContainer = $('#nova-single-dm-messages');
        $messagesContainer.empty();

        const stContext = SillyTavern.getContext();
        const activeProfiles = getActiveProfiles();
        const userProfile = activeProfiles.find(ap => ap.isUser) || { name: stContext.name1 || 'Вы', color: '#1da1f2' };

        thread.messages = thread.messages || [];
        thread.messages.forEach((msg, msgIndex) => {
            const isUser = msg.sender === 'user';
            // Через переменные с фолбэком — тема 'default' их не задаёт, и пузыри
            // остаются обычными, без ветвлений в самом шаблоне
            const bgColor = isUser
                ? 'var(--nova-dm-user-bubble, var(--nova-accent))'
                : 'var(--nova-dm-other-bubble, var(--nova-surface-hover))';
            const textColor = isUser
                ? 'var(--nova-dm-user-text, #fff)'
                : 'var(--nova-dm-other-text, var(--nova-text))';
            // Предложение аватара/смена обоев/темы — не реплика ни от одной из сторон,
            // а системная карточка по центру, как в Телеграме: выравнивание "как у юзера" тут неуместно
            const isSystemCard = !!(msg.avatarSuggestion || msg.wallpaperChange || msg.themeChange);
            const alignSelf = isSystemCard ? 'center' : (isUser ? 'flex-end' : 'flex-start');
            const borderRadius = isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px';
            const rowDirection = isUser ? 'row-reverse' : 'row';

            const senderNameHtml = (thread.isGroup && !isUser)
                ? `<div style="font-size: 11px; color: var(--nova-accent); margin-bottom: 2px; padding-left: 4px; font-weight: bold;">${msg.sender_name || msg.sender}</div>`
                : '';

            const msgHtml = `
                <div class="nova-dm-message-wrapper" data-msg-index="${msgIndex}" style="display: flex; flex-direction: column; align-items: ${alignSelf}; margin-bottom: 12px; max-width: 85%; align-self: ${alignSelf};">
                    ${senderNameHtml}
                    <div style="display: flex; align-items: center; gap: 8px; flex-direction: ${isSystemCard ? 'row' : rowDirection};">
                        <input type="checkbox" class="nova-dm-delete-checkbox" style="display: none; width: 18px; height: 18px; accent-color: #f44336; cursor: pointer; flex-shrink: 0;">
                        ${msg.avatarSuggestion ? renderAvatarSuggestionCard(msg.avatarSuggestion, thread) : msg.wallpaperChange ? renderWallpaperChangeCard(msg.wallpaperChange, thread) : msg.themeChange ? renderThemeChangeCard(msg.themeChange, thread) : msg.transfer ? renderTransferCard(msg.transfer, isUser) : `
                        <div style="background: ${bgColor}; color: ${textColor}; padding: 10px 14px; border-radius: ${borderRadius}; font-size: 15px; line-height: 1.4; word-break: break-word;">
                            ${formatPostText(msg.text)}
                            ${renderAttachedImage({...msg, type: 'dm', msgIndex: msgIndex}, msg.text ? '' : 'margin-top: 0;')}
                            ${renderMusicShare(msg)}
                        </div>`}
                    </div>
                    <div style="font-size: 11px; color: var(--nova-text-muted); margin-top: 4px; padding: 0 4px;">
                        ${msg.time}
                    </div>
                </div>
            `;
            $messagesContainer.append(msgHtml);
            $messagesContainer.append(renderContextMarkers(msg));
        });

        $messagesContainer.off('click', '.nova-avatar-suggestion-photo, .nova-avatar-suggestion-view').on('click', '.nova-avatar-suggestion-photo, .nova-avatar-suggestion-view', function() {
            const src = $(this).closest('.nova-avatar-suggestion-card').find('img').attr('src');
            if (src) openImageViewer({ image: src });
        });

        let lastCheckedDMIndex = null;
        $messagesContainer.off('change', '.nova-dm-delete-checkbox').on('change', '.nova-dm-delete-checkbox', function() {
            const currentIdx = $(this).closest('.nova-dm-message-wrapper').data('msg-index');
            if (this.checked) {
                if (lastCheckedDMIndex !== null && lastCheckedDMIndex !== currentIdx) {
                    const minIdx = Math.min(lastCheckedDMIndex, currentIdx);
                    const maxIdx = Math.max(lastCheckedDMIndex, currentIdx);
                    
                    $('.nova-dm-message-wrapper').each(function() {
                        const idx = $(this).data('msg-index');
                        if (idx >= minIdx && idx <= maxIdx) {
                            $(this).find('.nova-dm-delete-checkbox').prop('checked', true);
                        }
                    });
                }
                lastCheckedDMIndex = currentIdx;
            } else {
                lastCheckedDMIndex = null;
            }
        });

        // Дословная вставка этой переписки в чат ролеплея
        $('#nova-single-dm-transcript-btn').off('click').on('click', function() {
            try {
                insertThreadTranscript(index);
            } catch (e) {
                console.error('[NOVA] Thread transcript insert failed', e);
                toastr.error('Не удалось вставить переписку: ' + (e.message || ''));
            }
        });

        // Delete mode handlers
        $('#nova-single-dm-delete-mode-btn').off('click').on('click', function() {
            const isDeleteMode = $messagesContainer.hasClass('delete-mode');
            if (isDeleteMode) {
                $messagesContainer.removeClass('delete-mode');
                $('.nova-dm-delete-checkbox').hide().prop('checked', false);
                $('#nova-single-dm-input-area').show();
                $('#nova-single-dm-delete-actions').hide();
                $(this).css('color', 'var(--nova-text-muted)');
            } else {
                $messagesContainer.addClass('delete-mode');
                $('.nova-dm-delete-checkbox').show();
                $('#nova-single-dm-input-area').hide();
                $('#nova-single-dm-delete-actions').css('display', 'flex');
                $(this).css('color', '#f44336');
            }
        });

        $('#nova-single-dm-cancel-delete').off('click').on('click', function() {
            $messagesContainer.removeClass('delete-mode');
            $('.nova-dm-delete-checkbox').hide().prop('checked', false);
            $('#nova-single-dm-input-area').show();
            $('#nova-single-dm-delete-actions').hide();
            $('#nova-single-dm-delete-mode-btn').css('color', 'var(--nova-text-muted)');
        });

        $('#nova-single-dm-confirm-delete').off('click').on('click', function() {
            const indicesToDelete = [];
            $('.nova-dm-delete-checkbox:checked').each(function() {
                indicesToDelete.push($(this).closest('.nova-dm-message-wrapper').data('msg-index'));
            });

            if (indicesToDelete.length === 0) return;

            const label = pluralRu(indicesToDelete.length, 'сообщение', 'сообщения', 'сообщений');
            novaConfirm(`Удалить ${label}? Это действие необратимо.`, () => {
                indicesToDelete.sort((a, b) => b - a);
                indicesToDelete.forEach(idx => {
                    revertRelationshipsDeep(thread.messages[idx]);
                    revertWallpaperIfDeleted(thread, thread.messages[idx]);
                    revertThemeIfDeleted(thread, thread.messages[idx]);
                    thread.messages.splice(idx, 1);
                });

                saveFeed();

                // Exit delete mode state before re-rendering
                $messagesContainer.removeClass('delete-mode');
                $('#nova-single-dm-input-area').show();
                $('#nova-single-dm-delete-actions').hide();
                $('#nova-single-dm-delete-mode-btn').css('color', 'var(--nova-text-muted)');

                openSingleDM(index);
                toastr.success(`Удалено: ${label}.`);
            });
        });

        // Выпадающее меню «плюс»: фото и перевод
        const closePlusMenu = () => {
            $('#nova-dm-plus-menu').removeClass('open');
            $('#nova-dm-plus').removeClass('open');
        };
        $('#nova-dm-plus').off('click').on('click', e => {
            e.stopPropagation();
            $('#nova-dm-plus-menu').toggleClass('open');
            $('#nova-dm-plus').toggleClass('open');
        });
        $(document).off('click.novaDmPlus').on('click.novaDmPlus', e => {
            if (!$(e.target).closest('.nova-dm-plus-wrap').length) closePlusMenu();
        });

        $('#nova-dm-transfer').off('click').on('click', async () => {
            closePlusMenu();

            // В беседе получателя надо выбрать; в личке он один и вопрос не задаём
            const recipients = thread.isGroup
                ? (thread.participants || []).map(h => {
                    const p = getActiveProfiles().find(ap => normHandle(ap.handle) === normHandle(h));
                    return { handle: h, name: p?.name || h };
                })
                : [{ handle: thread.handle, name: thread.name }];

            const result = await novaTransferDialog(recipients);
            if (!result) return;

            const to = result.to || recipients[0]?.handle || thread.handle;
            const toName = recipients.find(r => normHandle(r.handle) === normHandle(to))?.name || thread.name;

            thread.messages.push({
                text: '',
                transfer: {
                    amount: result.amount,
                    currency: result.currency,
                    note: result.note,
                    to,
                    to_name: thread.isGroup ? toName : undefined,
                },
                sender: 'user',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
            saveFeed();
            openSingleDM(index);
            // Без уведомления: перевод уже виден карточкой в самой переписке
            generateDMResponse(index);
        });

        // Предложить фото на аватар — только личка: групповой "чей аватар" неоднозначен
        $('#nova-dm-suggest-avatar').toggle(!thread.isGroup);
        $('#nova-dm-suggest-avatar').off('click').on('click', () => {
            closePlusMenu();
            if (thread.isGroup) return;
            $('#nova-dm-avatar-suggest-input').trigger('click');
        });
        $('#nova-dm-avatar-suggest-input').off('change').on('change', async function() {
            const file = this.files?.[0];
            this.value = '';
            if (!file) return;

            try {
                // 768px — как у референсов внешности: для аватарки достаточно, папка не раздувается
                const dataUrl = await compressImageFile(file, 768, 0.85);
                const uploaded = await uploadNovaImageWithThumbnail(dataUrl);
                thread.messages.push({
                    text: '',
                    avatarSuggestion: { image: uploaded.image, status: 'pending' },
                    sender: 'user',
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                });
                saveFeed();
                openSingleDM(index);
                // Модель должна реально УВИДЕТЬ фото, а не просто узнать о нём — та же
                // схема передачи, что и у обычной прикреплённой картинки
                generateDMResponse(index, dataUrl);
            } catch (e) {
                console.error('[NOVA] Не удалось предложить аватар', e);
                toastr.error('Не удалось отправить фото: ' + (e.message || ''));
            }
        });

        // Обои чата — тоже только личка, привязаны к конкретному собеседнику,
        // не к группе. В отличие от предложки аватара — не решение персонажа,
        // юзер просто ставит их сразу, а персонаж лишь реагирует на это в ответе.
        $('#nova-dm-set-wallpaper').toggle(!thread.isGroup);
        $('#nova-dm-set-wallpaper').off('click').on('click', () => {
            closePlusMenu();
            if (thread.isGroup) return;
            $('#nova-dm-wallpaper-input').trigger('click');
        });
        $('#nova-dm-wallpaper-input').off('change').on('change', async function() {
            const file = this.files?.[0];
            this.value = '';
            if (!file) return;

            try {
                // Фон на весь экран — сжимаем крупнее, чем аватарки/референсы
                const dataUrl = await compressImageFile(file, 1024, 0.85);
                const uploaded = await uploadNovaImageWithThumbnail(dataUrl);
                thread.wallpaper = uploaded.image;
                thread.messages.push({
                    text: '',
                    wallpaperChange: { image: uploaded.image },
                    sender: 'user',
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                });
                saveFeed();
                openSingleDM(index);
                // Та же схема, что у предложки аватара — модель должна реально
                // УВИДЕТЬ картинку, чтобы реагировать на то, что на ней, а не абстрактно
                generateDMResponse(index, dataUrl);
            } catch (e) {
                console.error('[NOVA] Не удалось установить обои', e);
                toastr.error('Не удалось установить обои: ' + (e.message || ''));
            }
        });

        // Тема чата — не своя картинка, а пресет из NOVA_DM_THEMES: пикер вместо
        // файлового диалога.
        $('#nova-dm-set-theme').toggle(!thread.isGroup);
        $('#nova-dm-set-theme').off('click').on('click', () => {
            closePlusMenu();
            if (thread.isGroup) return;
            openThemePickerModal(index, thread);
        });

        $('#nova-dm-attach').off('click').on('click', () => {
            closePlusMenu();
            $('#nova-dm-image-input').trigger('click');
        });
        $('#nova-dm-image-input').off('change').on('change', async function() {
            await attachPendingImage('dm', this.files?.[0], '#nova-dm-image-preview');
            this.value = '';
        });
        $('#nova-dm-image-preview').off('click').on('click', '.nova-image-remove', () => clearPendingImage('dm'));

        // Поле стало textarea (раньше было однострочным <input>, где перенос строки
        // физически не наберёшь) — растёт вместе с текстом, а не прячет лишние строки
        // за внутренним скроллом
        $('#nova-single-dm-reply-input').off('input.novaGrow').on('input.novaGrow', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        $('#nova-single-dm-reply-btn').off('click').on('click', async () => {
            // Строка — отдельное сообщение: несколько мыслей подряд, а не одна длинная
            // склейка, и персонаж отвечает на каждое по очереди, как в живой переписке
            // Проверяем ДО того, как заберём текст из поля: иначе повторное нажатие
            // (пока предыдущий ответ ещё идёт) очистило бы ввод, а генерацию не
            // запустило — набранное просто пропадало бы
            if (isDMGenerating(thread)) {
                toastr.info('Дождитесь ответа — по этой переписке уже идёт генерация.');
                return;
            }

            const lines = $('#nova-single-dm-reply-input').val().split('\n').map(l => l.trim()).filter(Boolean);
            const image = pendingImages.dm;
            if (!lines.length && !image) return;

            // Команда ("/фото ...", "/музыка ...", "/плейлист ...") заменяет ОДНУ
            // свою строку карточкой, которую юзер физически не может собрать сам
            // (сгенерированное фото, оформленный трек) — но остальные строки вокруг
            // неё (подпись до или после, в любом порядке) идут как обычные реплики
            // в том же батче. Срабатывает только когда нет настоящего прикреплённого
            // фото и ровно ОДНА строка похожа на команду — если их несколько,
            // непонятно, какую выполнять, и весь ввод уходит как обычный текст.
            if (!image && lines.length) {
                const commandLines = lines
                    .map((line, i) => ({ i, command: parseUserDMCommand(line) }))
                    .filter(x => x.command);

                if (commandLines.length === 1) {
                    const { i: commandIndex, command } = commandLines[0];
                    // Без активного профиля картинок фото сгенерировать нечем — лучше
                    // сказать об этом сразу, чем тратить запрос к текстовой модели
                    // на промпт, по которому всё равно ничего не нарисуется
                    if (command.type === 'photo' && !getImageBudget()) {
                        toastr.warning('Генерация изображений выключена в настройках Nova.');
                        return;
                    }
                    $('#nova-single-dm-reply-input').val('').css('height', '');
                    hideDMCommandHints();

                    // Сообщения игрока собираем САМИ и кладём сразу — они появляются
                    // в переписке мгновенно, ещё до ответа модели. Командную строку —
                    // карточкой (см. buildUserCommandMessage), остальные — обычным
                    // текстом, каждая в своём порядке набора.
                    lines.forEach((line, i) => {
                        thread.messages.push(i === commandIndex
                            ? buildUserCommandMessage(command)
                            : { text: line, sender: 'user', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
                    });
                    saveFeed();
                    openSingleDM(index);
                    generateDMResponse(index, null, command);
                    return;
                }
            }

            const $btn = $('#nova-single-dm-reply-btn').prop('disabled', true);
            let imagePath = '';
            let imageThumb = '';
            if (image) {
                try {
                    const uploaded = await uploadNovaImageWithThumbnail(image);
                    imagePath = uploaded.image;
                    imageThumb = uploaded.thumbnail;
                } catch (e) {
                    console.error('[NOVA] Не удалось загрузить изображение', e);
                    toastr.error('Не удалось загрузить изображение: ' + (e.message || ''));
                    $btn.prop('disabled', false);
                    return;
                }
            }

            $('#nova-single-dm-reply-input').val('').css('height', '');
            hideDMCommandHints();
            clearPendingImage('dm');
            $btn.prop('disabled', false);

            // Каждая строка — своя пузырь-реплика, как серия сообщений в мессенджере,
            // но ВСЕ они уходят в ОДНОМ запросе к модели: сначала кладём их все в тред,
            // и только потом один раз зовём генерацию. Раньше на каждую строку уходил
            // отдельный запрос — персонаж отвечал между каждой репликой по очереди,
            // это было и медленно, и не тем, что имелось в виду.
            const queue = lines.length ? lines : [''];
            queue.forEach((line, i) => {
                thread.messages.push({
                    text: line,
                    image: (i === 0 && imagePath) || undefined,
                    thumbnail: (i === 0 && imageThumb) || undefined,
                    userPhoto: (i === 0 && !!imagePath) || undefined,
                    sender: 'user',
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                });
            });
            saveFeed();
            openSingleDM(index); // Re-render instantly

            // Картинку отдаём модели один раз — она относится к первому сообщению серии
            await generateDMResponse(index, image);
        });

        $('#nova-view-new-dm-overlay').removeClass('active');
        $('#nova-view-single-dm').addClass('active');
        // Зайти в переписку можно и посреди генерации (ушли в другую вкладку и
        // вернулись) — кнопка отправки должна отражать это состояние, а не быть
        // активной только потому, что вид перерисовался заново
        syncDMSendButton(thread);

        // Scroll to bottom
        setTimeout(() => {
            $messagesContainer.scrollTop($messagesContainer[0].scrollHeight);
        }, 50);
    }

    /**
     * Сообщение для истории в промпте. Картинку саму по себе модель в истории не увидит
     * (в запрос уходит только последняя), но без пометки сообщение-картинка выглядит
     * как пустая строка — отсюда и «странное» поведение персонажей.
     */
    /**
     * Аватар треда — один рендер на список и на шапку.
     * У группы без картинки показываем иконку людей, а не первую букву: так группа
     * сразу отличается от личной переписки.
     */
    /**
     * Ответов у поста — вместе со всеми вложенными ветками.
     * Раньше считалась только верхушка, поэтому спор персонажей в глубине треда
     * не попадал в счётчик и цифра расходилась с тем, что видно.
     */
    // «15м», «2ч», «3д» → минуты. Модель пишет их по-разному, поэтому берём и латиницу.
    function parseRelativeTime(value) {
        const str = String(value || '').trim().toLowerCase();
        const match = str.match(/(\d+)\s*([мmчhдd])/);
        if (!match) return 0;
        const amount = parseInt(match[1], 10) || 0;
        const unit = match[2];
        if (unit === 'ч' || unit === 'h') return amount * 60;
        if (unit === 'д' || unit === 'd') return amount * 60 * 24;
        return amount;
    }

    function formatRelativeTime(minutes) {
        const m = Math.max(0, Math.round(minutes));
        if (m < 1) return 'только что';
        if (m < 60) return `${m}м`;
        if (m < 60 * 24) return `${Math.floor(m / 60)}ч`;
        const days = Math.floor(m / (60 * 24));
        return days < 7 ? `${days}д` : `${Math.floor(days / 7)}нед`;
    }

    // Насколько пост стар относительно самого свежего события в ленте
    function describePostAge(post) {
        if (typeof post?.rpMinutes !== 'number') return post?.time || '';
        const newest = feedPosts.reduce((max, p) => (typeof p?.rpMinutes === 'number' && p.rpMinutes > max ? p.rpMinutes : max), rpClock);
        return formatRelativeTime(newest - post.rpMinutes);
    }

    function countRepliesDeep(replies) {
        if (!Array.isArray(replies)) return 0;
        return replies.reduce((sum, r) => sum + 1 + countRepliesDeep(r?.replies), 0);
    }

    /**
     * Флаги «здесь заканчивается сохранённый контекст» живут в ленте, а сам саммари —
     * в сообщении чата. Если сообщение удалили, флаг осиротел и полоса висела навсегда.
     */
    /**
     * Блок из чата могли удалить руками — тогда полоска врёт, будто событие уже
     * ушло в ролеплей. Проверяем каждый вид отдельно: пересказ и вставка живут
     * в разных блоках, и удаление одного не должно снимать полоску второго.
     */
    function syncSummaryMarkers() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const chat = stContext?.chat || [];

        // Какие виды блоков реально лежат в чате прямо сейчас
        const present = new Set();
        chat.forEach(m => {
            if (typeof m?.mes !== 'string' || !m.mes.includes('nova-hidden-context')) return;
            const re = contextMarkerRegex();
            let match;
            while ((match = re.exec(m.mes)) !== null) present.add(contextKindByLabel(match[1]));
        });

        let changed = false;
        Object.entries(CONTEXT_KINDS).forEach(([name, kind]) => {
            if (present.has(name)) return;
            const hasFlag = feedPosts.some(p => p?.[kind.mark])
                || dmThreads.some(t => t?.messages?.some(m => m?.[kind.mark]));
            if (!hasFlag) return;

            feedPosts.forEach(p => delete p[kind.mark]);
            dmThreads.forEach(t => t?.messages?.forEach(m => delete m[kind.mark]));
            changed = true;
            console.log(`[NOVA] «${kind.title}» в чате больше нет — метки сняты.`);
        });

        if (changed) saveFeed();
    }

    /**
     * Тред хранит снимок имени и аватара на момент создания. После переименования профиля
     * в списке DM оставалось старое имя — подтягиваем актуальное перед отрисовкой.
     * Группы не трогаем: у них собственные имя и аватар.
     */
    function refreshThreadProfiles() {
        const profiles = getActiveProfiles();
        let changed = false;

        dmThreads.forEach(thread => {
            if (!thread || thread.isGroup) return;
            const profile = profiles.find(p => normHandle(p.handle) === normHandle(thread.handle));
            if (!profile) return;

            if (profile.name && thread.name !== profile.name) { thread.name = profile.name; changed = true; }
            if (profile.avatar !== undefined && thread.avatar !== profile.avatar) { thread.avatar = profile.avatar; changed = true; }
            if (profile.color && thread.color !== profile.color) { thread.color = profile.color; changed = true; }
        });

        if (changed) saveFeed();
    }

    function renderThreadAvatar(thread, size = 48, extraClass = '') {
        const cls = `nova-profile-avatar ${extraClass}`.trim();
        const box = `width:${size}px;height:${size}px;min-width:${size}px;`;

        if (thread?.avatar) {
            return `<img src="${thread.avatar}" class="${cls}" onerror="this.style.display='none'" style="${box}object-fit:cover;">`;
        }

        const inner = thread?.isGroup
            ? `<i class="fa-solid fa-user-group" style="font-size:${Math.round(size * 0.4)}px;"></i>`
            : (thread?.name || '?').charAt(0).toUpperCase();

        return `<div class="${cls}" style="${box}background-color:${thread?.color || '#333'};color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:${Math.round(size * 0.42)}px;">${inner}</div>`;
    }

    // Подпись под названием: у человека — хэндл, у группы он бессмысленный, показываем состав
    function describeThreadSubtitle(thread) {
        if (!thread?.isGroup) return thread?.handle || '';
        const count = (thread.participants || []).length;
        const plural = count === 1 ? 'участник' : (count >= 2 && count <= 4 ? 'участника' : 'участников');
        return `${count} ${plural}`;
    }

    /**
     * Модели любят подписываться прямо в тексте — «[@handle]: сообщение» или «Имя: сообщение».
     * В групповой беседе подпись рисуется отдельно, поэтому такой префикс это мусор.
     */
    // Склонение: 1 сообщение, 2 сообщения, 5 сообщений
    function pluralRu(count, one, few, many) {
        const n = Math.abs(count) % 100;
        const n1 = n % 10;
        let word = many;
        if (n > 10 && n < 20) word = many;
        else if (n1 > 1 && n1 < 5) word = few;
        else if (n1 === 1) word = one;
        return `${count} ${word}`;
    }

    /**
     * Модель нередко впихивает в одно поле text целую перепалку:
     * «реплика. [@kid]: ответ. [@fogel]: ещё ответ». Режем это на отдельные сообщения,
     * иначе весь диалог показывается одним пузырём от одного отправителя.
     * @returns {{handle: string|null, text: string}[]}
     */
    function splitMultiSpeakerText(text) {
        const raw = String(text || '').trim();
        if (!raw) return [];

        const marker = /\[\s*@([\w.]+)\s*\]\s*:\s*/g;
        const parts = [];
        let lastIndex = 0;
        let pendingHandle = null;
        let match;

        while ((match = marker.exec(raw)) !== null) {
            const chunk = raw.slice(lastIndex, match.index).trim();
            if (chunk) parts.push({ handle: pendingHandle, text: chunk });
            pendingHandle = `@${match[1]}`;
            lastIndex = marker.lastIndex;
        }

        const tail = raw.slice(lastIndex).trim();
        if (tail) parts.push({ handle: pendingHandle, text: tail });

        return parts.length ? parts : [{ handle: null, text: raw }];
    }

    /**
     * Приводит ошибку API к понятному тексту. Таверна теряет HTTP-статус и часто отдаёт
     * голое «Response not OK», поэтому вытаскиваем причину из текста и переводим.
     */
    /**
     * Отдаёт текст ошибки ровно так, как его вернули Таверна и провайдер.
     * Свои формулировки не подставляем: подменённый текст скрывает настоящую причину.
     * Единственная работа тут — вытащить причину из обёртки ST («API request failed»).
     */
    function describeApiError(error) {
        const cause = String(error?.cause?.message || '').trim();
        const own = String(error?.message || error || '').trim();
        const raw = cause || own;
        if (!raw) return 'Провайдер не вернул текста ошибки — смотрите консоль Таверны.';
        return raw;
    }

    function stripInlineSenderPrefix(text, handle = '') {
        let result = String(text || '').trim();
        result = result.replace(/^\[\s*@?[\w.]+\s*\]\s*:\s*/i, '');
        if (handle) {
            const bare = String(handle).replace(/^@/, '');
            result = result.replace(new RegExp(`^@?${escapeRegex(bare)}\\s*:\\s*`, 'i'), '');
        }
        return result.trim();
    }

    function describeDMMessage(msg) {
        if (msg?.avatarSuggestion) {
            const s = msg.avatarSuggestion;
            const status = s.status === 'accepted' ? 'персонаж принял и уже сменил фото'
                : s.status === 'declined' ? 'персонаж отклонил'
                : 'персонаж ещё не ответил';
            return `[юзер предложил фото на аватар профиля; ${status}]`;
        }
        if (msg?.wallpaperChange) {
            return `[юзер установил(а) новые обои в этой переписке]`;
        }
        if (msg?.themeChange) {
            const theme = getDMTheme(msg.themeChange.themeId);
            return `[юзер сменил(а) тему оформления переписки на «${theme.name}»]`;
        }
        if (msg?.transfer) {
            const amount = formatMoney(msg.transfer.amount, msg.transfer.currency);
            const note = String(msg.transfer.note || '').trim();
            const to = String(msg.transfer.to_name || msg.transfer.to || '').trim();
            const dir = msg.sender === 'user'
                ? `игрок перевёл ${amount}${to ? ` получателю ${to}` : ''}`
                : `вам перевели ${amount}`;
            return `[денежный перевод: ${dir}${note ? `, комментарий: «${note}»` : ''}]`;
        }
        if (msg?.musicShare?.tracks?.length) {
            const who = msg.sender === 'user' ? 'игрок' : 'вы';
            const list = msg.musicShare.tracks.join(', ');
            return msg.musicShare.playlistName
                ? `[${who} собрали плейлист «${msg.musicShare.playlistName}»: ${list}]`
                : `[${who} поделились треком: ${list}]`;
        }
        const text = String(msg?.text || '').trim();
        if (!msg?.image) return text;
        // Полный промпт, а не «прикреплено изображение» без подробностей: модель,
        // читающая саммари в основном чате, иначе не знает, что именно на фото
        const imagePrompt = String(msg.imagePrompt || '').trim().replace(/\s+/g, ' ');
        if (imagePrompt) {
            return text ? `${text} [прикреплено изображение: ${imagePrompt}]` : `[прислал(а) изображение: ${imagePrompt}]`;
        }
        return text ? `${text} [прикреплено изображение]` : '[прислал(а) изображение]';
    }

    /**
     * Валюта перевода от персонажа. Модель иногда забывает поле — тогда берём ту,
     * что уже использовалась в этой переписке, и только в последнюю очередь дефолт интерфейса.
     */
    function resolveTransferCurrency(raw, thread) {
        const code = String(raw || '').trim().toUpperCase();
        if (NOVA_CURRENCIES.some(c => c.code === code)) return code;

        for (let i = (thread?.messages?.length || 0) - 1; i >= 0; i--) {
            const previous = thread.messages[i]?.transfer?.currency;
            if (previous && NOVA_CURRENCIES.some(c => c.code === previous)) return previous;
        }
        return DEFAULT_CURRENCY;
    }

    function formatMoney(amount, currency = DEFAULT_CURRENCY) {
        const value = Math.max(0, Math.round(Number(amount) || 0));
        const symbol = NOVA_CURRENCIES.find(c => c.code === currency)?.symbol || currency;
        return `${value.toLocaleString('ru-RU')} ${symbol}`;
    }

    // Перевод рисуем карточкой, а не текстом — это отдельное событие, а не реплика
    function renderTransferCard(transfer, isUser) {
        const note = String(transfer?.note || '').trim();
        // В беседе важно, кому именно ушли деньги — иначе перевод выглядит адресованным всем
        const toName = String(transfer?.to_name || '').trim();
        const label = isUser
            ? (toName ? `Вы отправили — ${toName}` : 'Вы отправили')
            : 'Вам перевели';
        return `
            <div class="nova-transfer-card ${isUser ? 'outgoing' : 'incoming'}">
                <div class="nova-transfer-icon"><i class="fa-solid fa-arrow-${isUser ? 'up' : 'down'}"></i></div>
                <div style="min-width: 0;">
                    <div class="nova-transfer-amount">${formatMoney(transfer?.amount, transfer?.currency)}</div>
                    <div class="nova-transfer-label">${label}</div>
                    ${note ? `<div class="nova-transfer-note">${note}</div>` : ''}
                </div>
            </div>
        `;
    }

    // Единая карточка по центру переписки — как системное сообщение «предложить фото
    // профиля» в Телеграме: круглое превью, текст и кнопка «Посмотреть фото» внутри
    // одной плашки, а не пузырь диалога ни от одной из сторон.
    function renderAvatarSuggestionCard(suggestion, thread) {
        const name = escapeHtml(thread?.name || '');
        const text = suggestion.status === 'accepted'
            ? `${name} добавил(а) эту фотографию в профиль`
            : suggestion.status === 'declined'
            ? `${name} отклонил(а) предложенную фотографию`
            : `Вы предложили ${name} добавить эту фотографию в профиль`;
        return `
            <div class="nova-avatar-suggestion-card">
                <div class="nova-avatar-suggestion-photo"><img src="${escapeHtml(suggestion.image)}" alt=""></div>
                <div class="nova-avatar-suggestion-text">${text}</div>
                <button type="button" class="nova-avatar-suggestion-view">Посмотреть фото</button>
            </div>
        `;
    }

    // Та же карточка, что у предложки аватара (переиспользуем классы .nova-avatar-suggestion-*
    // целиком — визуально это тот же стиль уведомления по центру переписки), просто другой
    // текст и без статуса pending/accepted/declined — тут нечего решать, юзер уже поставил обои.
    function renderWallpaperChangeCard(change, thread) {
        const name = escapeHtml(thread?.name || '');
        return `
            <div class="nova-avatar-suggestion-card">
                <div class="nova-avatar-suggestion-photo wallpaper"><img src="${escapeHtml(change.image)}" alt=""></div>
                <div class="nova-avatar-suggestion-text">Вы установили обои в чате с ${name}</div>
                <button type="button" class="nova-avatar-suggestion-view">Посмотреть фото</button>
            </div>
        `;
    }

    // Та же карточка-уведомление, но вместо фото — сам свотч темы (её градиент),
    // без кнопки "посмотреть фото" — смотреть тут особо не на что, фон уже виден вокруг.
    function renderThemeChangeCard(change, thread) {
        const name = escapeHtml(thread?.name || '');
        const theme = getDMTheme(change.themeId);
        return `
            <div class="nova-avatar-suggestion-card">
                <div class="nova-avatar-suggestion-photo wallpaper nova-theme-art nova-theme-art-${escapeHtml(theme.id)}" style="background: ${theme.background || 'var(--nova-surface)'};"></div>
                <div class="nova-avatar-suggestion-text">Вы установили тему «${escapeHtml(theme.name)}» в чате с ${name}</div>
            </div>
        `;
    }

    // Пикер тем — сетка превьюшек (свотч из фона темы + два кружка цветов пузырей),
    // та же оверлей-механика, что у модалки плейлиста (append/remove из #nova-backdrop).
    function openThemePickerModal(index, thread) {
        $('#nova-theme-picker-overlay').remove();
        const activeId = thread.theme || 'default';
        const tiles = NOVA_DM_THEMES.map(t => `
            <div class="nova-theme-tile ${t.id === activeId ? 'active' : ''}" data-theme-id="${t.id}">
                <div class="nova-theme-swatch nova-theme-art nova-theme-art-${escapeHtml(t.id)}" style="background: ${t.background || 'var(--nova-bg)'};">
                    <span class="nova-theme-swatch-bubble" style="background: ${t.userBubble || 'var(--nova-accent)'};"></span>
                    <span class="nova-theme-swatch-bubble" style="background: ${t.otherBubble || 'var(--nova-surface-hover)'};"></span>
                </div>
                <div class="nova-theme-tile-name">${escapeHtml(t.name)}</div>
            </div>
        `).join('');
        const html = `
            <div id="nova-theme-picker-overlay" class="nova-folder-overlay active" style="z-index: 9999; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; background: rgba(0,0,0,0.6);">
                <div class="nova-theme-picker-modal">
                    <div class="nova-playlist-modal-header">
                        <div class="nova-playlist-modal-title">Тема чата</div>
                        <i class="fa-solid fa-xmark nova-playlist-modal-close"></i>
                    </div>
                    <div class="nova-theme-picker-grid">${tiles}</div>
                </div>
            </div>
        `;
        $('#nova-backdrop').append(html);

        $('#nova-theme-picker-overlay').on('click', function(e) { if (e.target === this) $(this).remove(); });
        $('.nova-theme-picker-modal .nova-playlist-modal-close').on('click', () => $('#nova-theme-picker-overlay').remove());
        $('.nova-theme-tile').on('click', function() {
            const themeId = $(this).data('theme-id');
            $('#nova-theme-picker-overlay').remove();
            applyDMTheme(index, thread, themeId);
        });
    }

    /** Применяет тему, кладёт уведомление в переписку и зовёт персонажа отреагировать. */
    function applyDMTheme(index, thread, themeId) {
        if ((thread.theme || 'default') === themeId) return;
        thread.theme = themeId;
        thread.messages.push({
            text: '',
            themeChange: { themeId },
            sender: 'user',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        saveFeed();
        openSingleDM(index);
        // Тут нечего показывать модели — не картинка, просто факт смены темы;
        // характер должен сам среагировать на её название/настроение из истории.
        generateDMResponse(index);
    }

    /** Инструкция про решение по аватару — пусто, если в треде нет нерешённого предложения. */
    function buildAvatarSuggestionInstruction(thread) {
        const pending = [...(thread?.messages || [])].reverse().find(m => m.avatarSuggestion?.status === 'pending');
        if (!pending) return '';
        return NovaPrompts.avatarSuggestionInstructionBlock();
    }

    /**
     * Ищет NPC-редактируемого персонажа по хэндлу в реальных карточках чата —
     * то же самое, что строит "Персонажи чата" (renderCharsTab), только без рендера.
     * Нужен, чтобы записать custom_avatar в charProfiles на верный ключ (memberId).
     */
    function findCharMemberIdByHandle(handle) {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext) return null;
        const charProfiles = stContext.extensionSettings?.NOVA?.charProfiles || {};
        const { characters, groups, characterId, groupId } = stContext;
        const key = normHandle(handle);

        const activePersona = getActivePersonaEntry();
        const personaProfile = (activePersona && charProfiles[activePersona.id]) || {};
        const personaHandle = personaProfile.handle || `@${transliterate(stContext.name1 || 'user')}`;
        if (normHandle(personaHandle) === key) return activePersona ? activePersona.id : ensureActivePersonaId();

        const matchChar = char => {
            const genProfile = charProfiles[char.avatar] || {};
            const h = genProfile.handle || `@${transliterate(char.name || 'user')}`;
            return normHandle(h) === key ? char.avatar : null;
        };

        if (groupId && groups) {
            const group = groups.find(g => g.id === groupId || String(g.id) === String(groupId));
            for (const memberId of (group?.members || [])) {
                const char = characters?.find(c => c.avatar === memberId || String(c.id) === String(memberId));
                if (char) {
                    const found = matchChar(char);
                    if (found) return found;
                }
            }
        } else if (characterId !== undefined && characters?.[characterId]) {
            const found = matchChar(characters[characterId]);
            if (found) return found;
        }
        return null;
    }

    /**
     * Применяет принятый аватар — NPC или реальному персонажу/персоне чата,
     * и синхронизирует уже сохранённые посты/переписку, где старая аватарка
     * могла закешироваться (см. syncProfilePosts).
     */
    function applySuggestedAvatar(handle, imagePath) {
        const npc = getAllFolders().flatMap(f => f.npcs).find(n => normHandle(n.handle) === normHandle(handle));
        if (npc) {
            npc.avatar = imagePath;
            saveFolders();
            syncProfilePosts(handle, { handle, name: npc.name, avatar: imagePath });
            return true;
        }

        const memberId = findCharMemberIdByHandle(handle);
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (memberId && ctx) {
            if (!ctx.extensionSettings.NOVA) ctx.extensionSettings.NOVA = {};
            if (!ctx.extensionSettings.NOVA.charProfiles) ctx.extensionSettings.NOVA.charProfiles = {};
            const existing = ctx.extensionSettings.NOVA.charProfiles[memberId] || {};
            ctx.extensionSettings.NOVA.charProfiles[memberId] = { ...existing, custom_avatar: imagePath };
            ctx.saveSettingsDebounced();
            syncProfilePosts(handle, { handle, name: existing.name, avatar: imagePath });
            return true;
        }

        return false;
    }

    /** Тот же формат тега, что у фото и симпатии: <span data-nova-avatar-decision='{...}'></span> */
    function extractAvatarDecisionTag(text) {
        const source = String(text || '');
        if (!source.includes('data-nova-avatar-decision')) return null;

        const found = extractSpanTagJson(source, 'data-nova-avatar-decision');
        if (!found) return null;

        // См. parseTagJson: сперва как есть, нормализация — запасным вариантом
        const data = parseTagJson(found.json);
        if (!data) return null;
        return { tag: found.tag, data, source: found.source };
    }

    /**
     * Разбирает решение по предложенному аватару, вычищает тег из текста, при
     * согласии применяет новый аватар. Ищет ПОСЛЕДНЕЕ нерешённое предложение в
     * треде — при обычной переписке 1-на-1 оно всегда единственное.
     */
    function absorbAvatarDecision(item, thread) {
        if (!item) return;
        const found = extractAvatarDecisionTag(item.text);
        if (!found) return;
        // См. комментарий в absorbRelationshipTag — режем относительно found.source
        item.text = String(found.source).replace(found.tag, '').replace(/\s{2,}/g, ' ').trim();

        const pending = [...(thread?.messages || [])].reverse().find(m => m.avatarSuggestion?.status === 'pending');
        if (!pending) return;

        const accepted = !!found.data.accept;
        pending.avatarSuggestion.status = accepted ? 'accepted' : 'declined';
        if (accepted) applySuggestedAvatar(thread.handle, pending.avatarSuggestion.image);
    }

    /**
     * Лента для промпта личных сообщений. Раньше в DM уходил только контекст РП и переписка,
     * поэтому персонажи не знали о постах игрока и переспрашивали то, что он уже написал в ленте.
     * Посты самого игрока помечаем отдельно — на них и реагируют.
     */
    function buildFeedContextForDM(userHandle, limit = getHistoryLimit('feed_history_size')) {
        const lines = [];
        for (const post of feedPosts.slice(0, limit)) {
            if (!post) continue;
            const text = String(post.text || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const isUser = normHandle(post.handle) === normHandle(userHandle);
            const image = post.image ? ' [с изображением]' : '';
            lines.push(`${isUser ? '>>> ПОСТ ИГРОКА' : post.handle}: ${text.slice(0, 200)}${image}`);
        }
        return lines.join('\n');
    }

    /**
     * Хвост переписки для промпта. Раньше уходил ВЕСЬ тред: промпт рос с каждым
     * сообщением, пока не упирался в лимит провайдера — отсюда 429 и обрывы JSON
     * на длинных переписках. Режем с конца: свежие сообщения важнее давних, а то,
     * что выпало, всё равно попадает в основной чат через синхронизацию.
     */
    function recentDMMessages(thread) {
        const limit = getHistoryLimit('dm_history_size');
        const messages = thread?.messages || [];
        return limit === Infinity ? messages : messages.slice(-limit);
    }

    /**
     * Переписки, по которым прямо сейчас идёт запрос к модели.
     *
     * Раньше защиты не было вовсе: два быстрых нажатия «отправить» (или отправка
     * поверх ещё не пришедшего ответа) запускали два параллельных запроса. Оба
     * вешали свой «печатает…», оба потом писали в thread.messages и звали saveFeed —
     * кто последний, тот и прав, а лишние реплики оставались висеть.
     *
     * Ключ — ХЭНДЛ, а не индекс: пока идёт запрос, тред может переехать в списке
     * (он сортируется по свежести), и индекс начнёт указывать на другую переписку.
     */
    const dmGenerationInFlight = new Set();

    function dmGenerationKey(thread) {
        return normHandle(thread?.handle || '') || String(thread?.name || '');
    }

    function isDMGenerating(thread) {
        return dmGenerationInFlight.has(dmGenerationKey(thread));
    }

    /** Кнопка отправки заблокирована, пока по ОТКРЫТОЙ переписке идёт генерация. */
    function syncDMSendButton(thread) {
        if (!thread || $('#nova-view-single-dm').attr('data-thread-handle') !== thread.handle) return;
        $('#nova-single-dm-reply-btn').prop('disabled', isDMGenerating(thread));
    }

    /**
     * @param {object|null} userCommand — результат parseUserDMCommand, когда этот
     *   заход запущен командой (/фото, /музыка, /плейлист): модель сначала
     *   оформляет ЕГО сообщение нужным тегом, потом как обычно реагирует.
     */
    async function generateDMResponse(index, imageDataUrl = null, userCommand = null) {
        const thread = dmThreads[index];
        if (!thread) return;

        // Страховка для остальных точек входа (перевод, обои, аватарка, перегенерация):
        // сообщение оттуда уже лежит в треде, поэтому просто не даём запустить второй
        // запрос поверх первого — ответ придёт на весь накопившийся хвост разом.
        const key = dmGenerationKey(thread);
        if (dmGenerationInFlight.has(key)) return;
        dmGenerationInFlight.add(key);
        syncDMSendButton(thread);
        try {
            await generateDMResponseInner(index, imageDataUrl, thread, userCommand);
        } finally {
            dmGenerationInFlight.delete(key);
            syncDMSendButton(thread);
        }
    }

    async function generateDMResponseInner(index, imageDataUrl, thread, userCommand = null) {

        // Своя картинка уходит непосредственно перед этим вызовом, но не обязательно
        // ПОСЛЕДНИМ сообщением треда — при серии из нескольких строк фото висит на
        // первой, а следом могли лечь ещё текстовые реплики. Ищем именно сообщение
        // с картинкой и без подписи, а не «последнее», чтобы подпись не улетела не туда.
        const ownImageMsg = imageDataUrl
            ? [...thread.messages].reverse().find(m => m.sender === 'user' && m.image && !m.imagePrompt)
            : null;

        const activeProfiles = getActiveProfiles();
        const userProfile = activeProfiles.find(ap => ap.isUser) || { name: 'Вы', handle: '@user', desc: '' };
        const userInfo = `${userProfile.name} (${userProfile.handle}) - ЭТО ПОЛЬЗОВАТЕЛЬ, С КОТОРЫМ ВЫ ПЕРЕПИСЫВАЕТЕСЬ. ${userProfile.desc || ''}`;
        
        let profileInfo = '';
        let prompt = '';

        if (thread.isGroup) {
            const participantsProfiles = activeProfiles.filter(p => thread.participants.includes(p.handle));
            profileInfo = participantsProfiles.map(p => {
                if (p.type === 'npc') {
                    return `${p.name} (${p.handle}): ${p.desc} | Стиль: ${p.style}`;
                } else {
                    return `${p.name} (${p.handle}): Персонаж из текущего чата.`;
                }
            }).join('\n\n');

            const messageHistory = recentDMMessages(thread).map(m => {
                const senderName = m.sender === 'user' ? userProfile.handle : (m.sender_handle || m.sender);
                return `${senderName}: ${describeDMMessage(m)}`;
            }).join('\n');

            const chatContext = await getChatContext();
            prompt = NovaPrompts.generateGroupDMReply(profileInfo, messageHistory, chatContext, userInfo, thread.name, !!imageDataUrl, buildFeedContextForDM(userProfile.handle), buildImageInstruction('dm') + buildRelationshipInstruction(userProfile.handle, 'dm') + buildAvatarSuggestionInstruction(thread) + buildMusicInstruction() + buildUserCommandInstruction(userCommand));
        } else {
            const profile = activeProfiles.find(ap => ap.handle.toLowerCase() === thread.handle.toLowerCase());
            
            if (profile) {
                if (profile.type === 'npc') {
                    profileInfo = `${profile.name} (${profile.handle}): ${profile.desc} | Стиль: ${profile.style}`;
                } else {
                    profileInfo = `${profile.name} (${profile.handle}): Персонаж из текущего чата — характер и стиль общения определяется его картой персонажа.`;
                }
            } else {
                profileInfo = `${thread.name} (${thread.handle}): Неизвестный профиль.`;
            }

            const messageHistory = recentDMMessages(thread).map(m => {
                return `${m.sender === 'user' ? userProfile.handle : thread.handle}: ${describeDMMessage(m)}`;
            }).join('\n');

            const chatContext = await getChatContext();
            prompt = NovaPrompts.generateDMReply(profileInfo, messageHistory, chatContext, userInfo, !!imageDataUrl, buildFeedContextForDM(userProfile.handle), buildImageInstruction('dm') + buildRelationshipInstruction(userProfile.handle, 'dm') + buildAvatarSuggestionInstruction(thread) + buildMusicInstruction() + buildUserCommandInstruction(userCommand));
        }

        // Add a loading indicator in the thread
        const $messagesContainer = $('#nova-single-dm-messages');
        const $loader = $(`
            <div id="nova-single-dm-loader" style="display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 12px; align-self: flex-start;">
                <div style="background: var(--nova-dm-other-bubble, var(--nova-surface-hover)); color: var(--nova-dm-other-text, var(--nova-text)); padding: 14px 18px; border-radius: 16px 16px 16px 4px; display: flex; align-items: center; gap: 8px;">
                    <div class="nova-typing-dots">
                        <div class="nova-typing-dot"></div>
                        <div class="nova-typing-dot"></div>
                        <div class="nova-typing-dot"></div>
                    </div>
                </div>
            </div>
        `);
        $messagesContainer.append($loader);
        $messagesContainer.scrollTop($messagesContainer[0].scrollHeight);

        try {
            const data = await callAIForJson(prompt, imageDataUrl ? [imageDataUrl] : [], d => d && (d.text || d.messages));

            $loader.remove();

            // Кладём в то же поле, что читает кнопка «промпт» у сгенерированных фото —
            // одна и та же кнопка показывает и промпт ИИ, и подпись собственного фото
            const caption = String(data.image_caption || '').trim();
            if (ownImageMsg && caption) ownImageMsg.imagePrompt = caption;

            // Фото по команде /фото: слот игрока уже лежит в треде со спиннером
            // (buildUserCommandMessage), модель этим же ответом прислала для него
            // "user_photo" — те же поля, что и в её собственном теге фото
            // (imageInstructionBlock), просто отдельным объектом, а не <img>-тегом
            // внутри текста: тут ему и вкладывать некуда, сообщение игрока уже своё.
            const commandPhotoMsg = userCommand?.type === 'photo'
                ? [...thread.messages].reverse().find(m => m.awaitingCommandPhoto)
                : null;
            if (commandPhotoMsg) {
                delete commandPhotoMsg.awaitingCommandPhoto;
                const userPhoto = (data.user_photo && typeof data.user_photo === 'object') ? data.user_photo : {};
                // Промпта нет — рисуем по описанию самого игрока, оно хуже как
                // промпт для генератора, но лучше, чем не сгенерировать вообще
                commandPhotoMsg.image_prompt = String(userPhoto.prompt || '').trim() || userCommand.description;
                commandPhotoMsg.image_opts = {
                    aspect_ratio: String(userPhoto.aspect_ratio || '').trim(),
                    image_size: String(userPhoto.image_size || '').trim(),
                    style: String(userPhoto.style || '').trim(),
                };
            }

            // /музыка и /плейлист: карточка уже видна с тем, что игрок ввёл дословно —
            // подменяем названия на нормализованные модель ("user_tracks"), если она
            // их прислала. Считаем совпадением только ТОЧНО то же число строк: если
            // модель вернула больше/меньше, чем было треков, доверять порядку нельзя —
            // остаётся то, что ввёл игрок, целым и невредимым.
            const commandMusicMsg = (userCommand && userCommand.type !== 'photo')
                ? [...thread.messages].reverse().find(m => m.awaitingTrackCorrection)
                : null;
            if (commandMusicMsg) {
                delete commandMusicMsg.awaitingTrackCorrection;
                const corrected = Array.isArray(data.user_tracks)
                    ? data.user_tracks.map(t => String(t || '').trim()).filter(Boolean)
                    : [];
                if (corrected.length === commandMusicMsg.musicShare.tracks.length) {
                    commandMusicMsg.musicShare.tracks = corrected;
                }
                recordSharedTracks(commandMusicMsg.musicShare.tracks);
            }

            let newMessages = data.messages ? data.messages : [data.text];
            // Считаем реально добавленные: часть ответов модели отсеивается как пустая,
            // и по длине исходного массива потом не найти, что именно легло в тред
            const addedMessages = [];

            newMessages.forEach(msgItem => {
                if (!msgItem) return;

                let text = '';
                let senderName = thread.name;
                let senderHandle = thread.handle;

                if (thread.isGroup && typeof msgItem === 'object') {
                    // Find actual profile from active profiles based on handle (регистр/@ не важны)
                    let rawHandle = msgItem.sender_handle ?? msgItem.author_handle;
                    // Хэндл самой беседы вместо участника — берём первого из состава
                    if (rawHandle && normHandle(rawHandle) === normHandle(thread.handle)) {
                        rawHandle = (thread.participants || [])[0] || rawHandle;
                    }
                    const p = resolveAuthorProfile(rawHandle, activeProfiles, msgItem.sender_name);
                    senderHandle = p.handle;
                    senderName = p.name;
                    text = stripInlineSenderPrefix(msgItem.text, p.handle);
                } else if (typeof msgItem === 'object') {
                    text = msgItem.text;
                } else {
                    text = msgItem;
                }

                // Персонаж может прислать перевод вместо/вместе с текстом
                const transferAmount = Math.round(Number(msgItem?.transfer?.amount ?? msgItem?.transfer));
                const hasTransfer = Number.isFinite(transferAmount) && transferAmount > 0;
                // Фото по команде юзера ("image_prompt" полем, не тегом в тексте — см.
                // "Equivalent alternative" в imageInstructionBlock) может прийти с пустым
                // "text" — это ожидаемо для одиночного фото. Раньше пустой text без
                // перевода отбрасывал сообщение целиком, теряя это самое фото.
                const hasImagePrompt = typeof msgItem === 'object' && !!String(msgItem.image_prompt || '').trim();

                if (!text && !hasTransfer && !hasImagePrompt) return;

                const transferCurrency = resolveTransferCurrency(msgItem?.transfer?.currency, thread);

                const added = {
                    text: text,
                    transfer: hasTransfer ? {
                        amount: transferAmount,
                        currency: transferCurrency,
                        note: String(msgItem?.transfer?.note || '').trim(),
                    } : undefined,
                    sender: 'npc',
                    sender_name: senderName,
                    sender_handle: senderHandle,
                    // Описание фото от модели — картинку дорисовываем ниже, когда
                    // весь пакет сообщений уже разобран
                    image_prompt: typeof msgItem === 'object' ? msgItem.image_prompt : undefined,
                    time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                };
                thread.messages.push(added);
                addedMessages.push(added);

                // Про перевод не уведомляем: карточка в переписке и так его показывает
            });

            // Тег вырезаем всегда, даже если генерация выключена или бюджет исчерпан —
            // см. комментарий у аналогичного места в generateFeed
            addedMessages.forEach(absorbImageTag);
            addedMessages.forEach(absorbRelationshipTag);
            addedMessages.forEach(absorbMusicTag);
            addedMessages.forEach(m => absorbAvatarDecision(m, thread));

            // Отсеиваем те, кому нельзя картинки, и вычисляем, кто реально получит
            // фото в этом заходе — ДО рендера, чтобы у них сразу стоял спиннер, а не
            // пустое место, которое через секунду дёрнется. Фото игрока по команде
            // /фото лежит не в addedMessages (оно попало в тред ещё до запроса), но
            // рисуется тем же конвейером — добавляем его сюда явно и первым.
            const photoTargets = [
                ...(commandPhotoMsg ? [commandPhotoMsg] : []),
                ...addedMessages.filter(m => canAttachPhoto(m.sender_handle || m.handle || '')),
            ];
            const imageTargets = getImageGenTargets(photoTargets);
            imageTargets.forEach(m => { m.imagePending = true; });
            addedMessages.forEach(m => { if (!imageTargets.includes(m)) delete m.image_prompt; });

            // Текст показываем сразу, не дожидаясь картинок: пользователь читает
            // ответ, пока фото ещё генерируются на своих местах.
            saveFeed();
            const isViewingThread = () => $('#nova-view-single-dm').hasClass('active') && $('#nova-view-single-dm').attr('data-thread-handle') === thread.handle;
            const renderThread = () => { if (isViewingThread()) openSingleDM(index); else renderDMs(); };

            if (isViewingThread()) {
                openSingleDM(index);
            } else {
                thread.unread += newMessages.length;
                updateUnreadBadge();
                renderDMs();
                toastr.success(`Новое сообщение от ${thread.name}!`);
            }

            if (imageTargets.length) {
                await attachGeneratedImages(photoTargets, () => {
                    saveFeed();
                    renderThread();
                });
            }

        } catch (e) {
            console.error("[NOVA] DM generation failed", e);
            toastr.error("Ошибка в DM: " + describeApiError(e));
            $loader.remove();

            // Несколько строк уходят ОДНИМ запросом (см. #nova-single-dm-reply-btn) —
            // при ошибке в поле ввода нужно вернуть ВСЕ строки неудавшейся отправки,
            // а не только последнюю, и убрать из треда весь батч целиком, а не одно
            // сообщение (иначе остальные строки повисают в треде без ответа). Строка
            // с командой текста не содержит (карточка или пустой слот под фото) —
            // для неё берём исходный ввод из userCommand.raw, а не m.text.
            const restoredLines = [];
            while (thread.messages.length && thread.messages[thread.messages.length - 1].sender === 'user') {
                const m = thread.messages.pop();
                restoredLines.unshift((m.awaitingCommandPhoto || m.musicShare) ? (userCommand?.raw || '') : String(m.text || ''));
            }
            if (restoredLines.length) {
                $('#nova-single-dm-reply-input').val(restoredLines.join('\n'));
                saveFeed();
                if ($('#nova-view-single-dm').hasClass('active') && $('#nova-view-single-dm').attr('data-thread-handle') === thread.handle) {
                    openSingleDM(index);
                }
            }
        }
    }

    /**
     * Что уже было в ленте. Без этого модель не видит собственных прошлых постов
     * и на каждой генерации заходит на те же темы по новому кругу.
     */
    function buildRecentPostsContext(limit = getHistoryLimit('feed_history_size')) {
        const lines = [];
        for (const post of feedPosts.slice(0, limit)) {
            if (!post) continue;
            const text = String(post.text || '').replace(/\s+/g, ' ').trim();
            if (text) lines.push(`${post.handle}: ${text.slice(0, 160)}`);
            for (const reply of (post.replies || []).slice(0, 2)) {
                const replyText = String(reply?.text || '').replace(/\s+/g, ' ').trim();
                if (replyText) lines.push(`  ${reply.handle}: ${replyText.slice(0, 100)}`);
            }
        }
        return lines.join('\n');
    }

    async function generateFeed(userPostText = null, attachment = {}) {
        const { imagePath = '', imageThumb = '', imageDataUrl = '' } = attachment || {};
        const $container = $('#nova-feed-container');
        if ($('#nova-feed-loader').length) return; // Prevent multiple clicks
        const $loader = $('<div id="nova-feed-loader" class="nova-loading" style="padding: 16px; border-bottom: 1px solid var(--nova-border); display: flex; justify-content: center; gap: 12px; align-items: center;"><i class="fa-solid fa-spinner fa-spin nova-spinner" style="font-size: 20px; color: var(--nova-accent);"></i><span style="color: var(--nova-text-muted);">Генерация ленты...</span></div>');
        $container.prepend($loader);
        
        const activeProfiles = getActiveProfiles();
        if (activeProfiles.length === 0) {
            toastr.warning("Нет активных профилей для генерации постов.");
            $loader.remove();
            return;
        }

        const profilesInfo = activeProfiles.map(p => {
            if (p.type === 'npc') {
                return `- ${p.name} (${p.handle}): ${p.desc} | Стиль: ${p.style}`;
            } else if (p.isUser) {
                return `- ${p.name} (${p.handle}): [ИГРОК / ЮЗЕР] КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО генерировать посты или сообщения от этого лица.`;
            } else {
                return `- ${p.name} (${p.handle}): Персонаж из текущего чата — характер и стиль постов определяется его картой персонажа выше.`;
            }
        }).join('\n');

        const chatContext = await getChatContext();
        const userHandle = activeProfiles.find(ap => ap.isUser)?.handle || '@user';
        
        const recentDMsContext = dmThreads.map(t => {
            if (!t.messages || t.messages.length === 0) return null;
            const msgs = t.messages.slice(-4).map(m => `[${m.sender === 'user' ? userHandle : (m.sender_handle || t.handle)}]: ${describeDMMessage(m)}`).join('\n');
            // Групповые беседы называем по имени и перечисляем состав — иначе модель
            // не знает, что это группа, и пишет в неё как в личку
            const header = t.isGroup
                ? `GROUP CHAT «${t.name}» (group_handle: ${t.handle}, members: ${(t.participants || []).join(', ') || '—'})`
                : `DM Thread with ${t.name} (${t.handle})`;
            return `${header}:\n${msgs}`;
        }).filter(Boolean).join('\n\n');

        const recentPostsContext = buildRecentPostsContext();

        // С конкретным userPostText вся пачка — реакции НА этот пост (создание поста,
        // «Перегенерировать»), а не обычное обновление ленты вперемешку с чужими темами —
        // строгий фильтр релевантности тут только душит тег, который и так уместен почти всегда
        const relTarget = userPostText ? 'feed-reaction' : 'feed';
        const prompt = NovaPrompts.generateFeed(profilesInfo, chatContext, userPostText, userHandle, recentDMsContext, recentPostsContext, !!imagePath, buildImageInstruction('feed') + buildRelationshipInstruction(userHandle, relTarget) + buildMusicInstruction());

        try {
            const data = await callAIForJson(prompt, imageDataUrl ? [imageDataUrl] : [], d => d && d.posts);

            const batchId = Date.now();

            // Двигаем виртуальные часы РП. Сколько прошло — говорит модель, глядя на сцену;
            // если не сказала, считаем, что прошёл час: лучше, чем вечные «15 минут назад».
            const elapsed = Number(data.elapsed_minutes);
            rpClock += Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(elapsed, 60 * 24 * 30) : 60;

            const newPosts = data.posts.filter(p => p && typeof p === 'object').map(p => {
                const profile = resolveAuthorProfile(p.author_handle ?? p.authorHandle ?? p.handle, activeProfiles, p.name);
                const replies = mapRepliesRecursive(p.replies, activeProfiles);

                return {
                    ...p,
                    handle: profile.handle,
                    name: profile.name,
                    avatar: profile.avatar || '',
                    color: profile.color || '#333',
                    text: p.text || '',
                    replies: replies,
                    batchId: batchId,
                    // Модель видит в контексте чата картинки от других расширений и
                    // возвращает поле image с чужим путём. Спред тащил его в пост,
                    // и в ленте появлялось фото из ролеплея. Ставить image имеет
                    // право только код — после того, как реально что-то нарисовал
                    image: undefined,
                    // «15м» из ответа — это возраст ВНУТРИ пачки, отсчитываем его от текущих часов
                    rpMinutes: rpClock - parseRelativeTime(p.time),
                };
            });

            // Пост юзера модель возвращает первым — к нему и прикрепляем загруженную картинку
            if (imagePath) {
                const ownPost = newPosts.find(p => normHandle(p.handle) === normHandle(userHandle));
                if (ownPost) {
                    ownPost.image = imagePath;
                    ownPost.thumbnail = imageThumb || imagePath;
                    // Своя фотка, не сгенерированная — у неё нет промпта генерации,
                    // даже если ниже появится imagePrompt (это подпись модели, а не
                    // инструкция для перерисовки). Кнопке «перегенерировать» тут делать нечего.
                    ownPost.userPhoto = true;
                    // Модель уже смотрела на фото, отвечая на пост — просили описание
                    // в том же ответе. Кладём в то же поле, что показывает кнопка
                    // «промпт» у сгенерированных картинок: одна кнопка на все фото.
                    const caption = String(ownPost.image_caption || '').trim();
                    if (caption) ownPost.imagePrompt = caption;
                    delete ownPost.image_caption;
                }
                else if (newPosts.length) {
                    newPosts[0].image = imagePath;
                    newPosts[0].thumbnail = imageThumb || imagePath;
                    newPosts[0].userPhoto = true;
                }
            }

            // Фото от персонажей. Пост игрока пропускаем: его картинку выбирает он сам.
            const allPostsFlat = [];
            const collectAll = (list) => {
                (list || []).forEach(p => {
                    allPostsFlat.push(p);
                    if (p.replies) collectAll(p.replies);
                });
            };
            collectAll(newPosts);

            // Тег вырезаем из текста ВСЕГДА, а не только когда генерация включена и есть
            // бюджет: иначе при выключенной фиче или превышенном лимите сырой
            // <img data-iig-instruction=...> остаётся в посте — виден в подписи и, что хуже,
            // уезжает в скрытый саммари чата, где его подхватит sillyimages и нарисует
            // дубль прямо в ролеплее
            allPostsFlat.forEach(absorbImageTag);
            allPostsFlat.forEach(absorbRelationshipTag);
            allPostsFlat.forEach(absorbMusicTag);

            const photoTargets = allPostsFlat.filter(p => normHandle(p.handle || p.author_handle) !== normHandle(userHandle));

            // Кто из них реально получит картинку в этом заходе — вычисляем ДО вставки
            // в ленту, чтобы на первом же рендере у них сразу стоял спиннер, а не
            // пустое место, которое через секунду дёрнется.
            const imageTargets = getImageGenTargets(photoTargets);
            imageTargets.forEach(item => { item.imagePending = true; });
            // Кому фото не досталось — за лимитом, заблокирован, или это пост самого
            // игрока (его картинку он выбирает сам): служебное поле им не нужно,
            // иначе оно зависает в сохранённом объекте навсегда
            allPostsFlat.forEach(p => { if (!imageTargets.includes(p)) delete p.image_prompt; });

            // Текст показываем сразу, не дожидаясь картинок: пользователь читает ленту,
            // пока фото ещё генерируются на её местах.
            feedPosts = [...newPosts.reverse(), ...feedPosts];
            saveFeed();
            renderFeed();
            $loader.remove();

            if (data.dm && data.dm.author_handle && data.dm.text) {
                // Модель может адресовать сообщение в существующую групповую беседу —
                // тогда автор и тред это РАЗНЫЕ сущности, и отправителя надо сохранить отдельно.
                // Хэндл группы иногда приезжает прямо в author_handle, поэтому ищем и по нему.
                const groupHandle = data.dm.group_handle || data.dm.thread_handle || data.dm.author_handle;
                let thread = dmThreads.find(t => t.isGroup && normHandle(t.handle) === normHandle(groupHandle));

                // Автор — участник группы, а не сама беседа. Иначе отправителем показывался «@group_xxxx».
                let authorHandle = data.dm.author_handle;
                if (thread && normHandle(authorHandle) === normHandle(thread.handle)) {
                    authorHandle = (thread.participants || [])[0] || authorHandle;
                }
                const profile = resolveAuthorProfile(authorHandle, activeProfiles, data.dm.name);

                if (!thread) thread = dmThreads.find(t => !t.isGroup && normHandle(t.handle) === normHandle(profile.handle));

                if (!thread) {
                    thread = {
                        name: profile.name,
                        handle: profile.handle,
                        avatar: profile.avatar,
                        color: profile.color,
                        unread: 0,
                        messages: []
                    };
                    dmThreads.unshift(thread);
                } else {
                    dmThreads = dmThreads.filter(t => t !== thread);
                    dmThreads.unshift(thread);
                }
                // В одном text может лежать целая перепалка с пометками [@handle] —
                // раскладываем её на отдельные сообщения от нужных участников
                splitMultiSpeakerText(data.dm.text).forEach(chunk => {
                    const chunkProfile = chunk.handle
                        ? resolveAuthorProfile(chunk.handle, activeProfiles, null)
                        : profile;
                    const text = stripInlineSenderPrefix(chunk.text, chunkProfile.handle);
                    if (!text) return;
                    thread.messages.push({
                        // Имя и хэндл автора обязательны: в группе подпись берётся именно отсюда,
                        // а без них рендер показывал служебное «npc»
                        text,
                        sender: 'npc',
                        sender_name: chunkProfile.name,
                        sender_handle: chunkProfile.handle,
                        time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                    });
                    thread.unread += 1;
                });
                toastr.success(`Новое сообщение от ${profile.name}${thread.isGroup ? ` в «${thread.name}»` : ''}!`);
                updateUnreadBadge();
            }

            saveFeed();
            renderDMs();

            // Картинки — уже после того, как текст и переписка показаны. Каждая
            // готовая (или не сгенерировавшаяся) картинка перерисовывает ленту сама:
            // спиннер на её месте сменяется результатом, не дожидаясь конца пачки.
            if (imageTargets.length) {
                await attachGeneratedImages(photoTargets, () => {
                    saveFeed();
                    renderFeed();
                    // Фон (лента) обновился, но если пользователь уже открыл этот
                    // пост в треде, страница треда сама себя не перерисует —
                    // спиннер/затычка там иначе висели бы до следующего открытия
                    refreshOpenDetailViewsFor(photoTargets);
                });
            }
        } catch (e) {
            console.error("[NOVA] AI processing failed", e);
            toastr.error("Ошибка генерации: " + describeApiError(e));
            $loader.remove();
            if (userPostText) {
                $('#nova-create-post-input').val(userPostText);
                $('#nova-view-create-post').addClass('active');
            }
        }
        $loader.remove();
        renderFeed();
    }

    async function generateNPCFolder() {
        toastr.info("ИИ анализирует мир для создания NPC...");
        
        const chatContext = await getChatContext();
        const prompt = NovaPrompts.generateNPCFolder(chatContext);

        try {
            const parsed = await callAIForJson(prompt, [], d => d && d.folder_name && d.npcs);

            const stContext = SillyTavern.getContext();
            const newFolder = {
                id: 'folder_' + Date.now(),
                name: parsed.folder_name || 'Сгенерированные NPC',
                icon: 'fa-robot',
                chatIds: [stContext.chatId],
                active: true,
                npcs: parsed.npcs.map((n, i) => ({
                    id: 'npc_' + Date.now() + '_' + i,
                    name: n.name,
                    handle: n.handle,
                    avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${n.seed || n.name}`,
                    color: n.color || '#' + Math.floor(Math.random()*16777215).toString(16),
                    desc: n.desc,
                    style: n.style,
                    active: true
                }))
            };

            customFolders.push(newFolder);
            toastr.success(`Создана папка: ${newFolder.name}`);
            renderProfilesTab();
            
        } catch (e) {
            console.error("[NOVA] NPC generation failed", e);
            toastr.error("Ошибка при генерации NPC: " + describeApiError(e));
        }
    }

    function loadStylesheet() {
        const cssId = 'nova-stylesheet';
        if (!$(`#${cssId}`).length) {
            $('head').append(`<link id="${cssId}" rel="stylesheet" href="scripts/extensions/${EXTENSION_PATH}/style.css?v=${Date.now()}">`);
        }
    }

    function injectWandButton() {
        $('#nova-options-button').remove();
        
        const $btn = $(`
            <a id="nova-options-button" title="Открыть NOVA (Social Feed)">
                <i class="fa-lg fa-solid fa-star"></i>
                <span>NOVA</span>
            </a>
        `);

        $btn.on('click', () => {
            openNovaPanel();
            $('#options').hide();
        });

        $('#options .options-content').append($btn);
        console.log("[NOVA] Options button injected.");
    }

    async function openNovaPanel() {
        if ($('#nova-backdrop').length === 0) {
            const { renderExtensionTemplateAsync } = SillyTavern.getContext();
            try {
                const html = await renderExtensionTemplateAsync(TEMPLATES_PATH, 'panel');
                $('body').append(html);
                bindPanelEvents();
                bindImageSettingsEvents();
                bindReferenceEvents();
                bindPhotoPermissionEvents();
                bindRelationshipEvents();
                bindMusicShareEvents();
            } catch (err) {
                console.error("[NOVA] Error loading template:", err);
                return;
            }
        }
        
        loadSettings();
        loadFolders();
        loadFeed();
        
        $('#nova-settings-summary-size').val(novaSummarySize);
        renderImageSettings();
        updateRelationshipBadge();

        // Музыка могла уже играть до открытия панели — подтягиваем название и состояние
        // разово, дальше их держат события moodtube:trackchange/statechange. Плашку это
        // само по себе НЕ покажет: пока не придёт реальное подтверждение воспроизведения
        // (trackchange или тик прогресса), она остаётся скрытой — см. moodTubePlaybackConfirmed.
        withMoodTube(api => {
            if (typeof api.getCurrentTrack === 'function') moodTubeNowPlaying = api.getCurrentTrack();
            if (typeof api.isPlaying === 'function') moodTubeIsPlaying = !!api.isPlaying();
            renderMoodTubeNowPlaying();
        });
        // Опрос живёт только пока панель открыта — при закрытии он останавливается
        // (см. stopMoodTubeStatePoll), поэтому поднимаем его на каждом открытии,
        // а не один раз при инициализации обработчиков
        startMoodTubeStatePoll();

        renderFeed();
        $('#nova-backdrop').fadeIn(200);
        $('.nova-nav-btn[data-target="feed"]').click();
    }

    function bindPanelEvents() {
        // Панель закрывают, не выходя из переписки — тему всё равно снимаем, иначе
        // при следующем открытии её цвета висели бы на ленте и модалках
        $('#nova-close-btn').on('click', () => {
            $('#nova-backdrop').fadeOut(200);
            clearDMThemeVars();
            stopMoodTubeStatePoll();
        });

        $('#nova-backdrop').on('click', function(e) {
            if (e.target === this) {
                $(this).fadeOut(200);
                clearDMThemeVars();
                stopMoodTubeStatePoll();
            }
        });
        
        $(document).on('click', '.nova-clickable-handle', function(e) {
            e.stopPropagation();
            const handle = $(this).data('handle');
            const profile = getActiveProfiles().find(p => p.handle.toLowerCase() === handle.toLowerCase());
            if (profile) {
                openPublicProfile(profile);
            } else {
                toastr.info(`Профиль ${handle} не найден.`);
            }
        });
        
        // Tab switching
        $('.nova-nav-btn').on('click', function() {
            const target = $(this).data('target');
            if (!target) return;
            
            $('.nova-nav-btn').removeClass('active');
            $(this).addClass('active');

            $('.nova-tab-view').removeClass('active');

            $(`#nova-view-${target}`).addClass('active');

            updateFeedFabs();

            if (target === 'settings') {
                if ($('#nova-proxy-list option').length <= 1) refreshConnectionProfiles();
                // Состав персонажей меняется вместе с чатом — список разрешений
                // и привязки референсов пересобираем при каждом заходе в настройки
                renderPhotoPermissions();
                renderReferenceSlots();
            }
            if (target === 'chars') {
                renderCharsTab();
                // NPC переехали на эту же вкладку, под список персонажей чата —
                // сетку папок нужно перерисовывать вместе с ним
                renderProfilesTab();
            }
            if (target === 'dms') {
                renderDMs();
            }
            if (target === 'history') {
                renderHistoryTab();
                renderFeedBackups();
            }
            if (target === 'gallery') {
                renderGalleryTab();
            }
            if (target === 'relationships') {
                renderRelationshipsTab();
            }
        });
        
        $(document).off('click', '#nova-settings-manual-sync-btn').on('click', '#nova-settings-manual-sync-btn', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            
            $btn.prop('disabled', true);
            const originalHtml = $btn.html();
            $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Синтез...');
            
            console.log("[NOVA] Manual sync button clicked");
            try {
                await generateContextSummary(false);
            } catch(e) {
                console.error(e);
            } finally {
                $btn.prop('disabled', false);
                $btn.html(originalHtml);
            }
        });

        // Дословная вставка: без ИИ, поэтому и без спиннера — отрабатывает мгновенно
        $(document).off('click', '#nova-settings-transcript-btn').on('click', '#nova-settings-transcript-btn', function() {
            console.log("[NOVA] Transcript button clicked");
            try {
                insertEventsTranscript();
            } catch (e) {
                console.error('[NOVA] Transcript insert failed', e);
                toastr.error('Не удалось вставить переписку: ' + (e.message || ''));
            }
        });

        $('#nova-settings-summary-size').on('change', function() {
            novaSummarySize = $(this).val();
            saveFolders();
            const label = $(this).find('option:selected').text();
            toastr.success("Размер пересказа: " + label);
        });

        $('#nova-refresh-proxy-btn').on('click', (e) => {
            e.preventDefault();
            refreshConnectionProfiles();
            toastr.info("Список профилей обновлен");
        });

        $(document).off('click', '.nova-history-jump-btn').on('click', '.nova-history-jump-btn', function() {
            const index = $(this).data('index');
            $('#nova-backdrop').fadeOut(200);
            // Третий путь закрытия панели, помимо крестика и клика по фону — тоже
            // должен гасить опрос MoodTube, иначе он тикает вхолостую до конца жизни
            // вкладки, ровно то, от чего избавлялись в первых двух местах
            clearDMThemeVars();
            stopMoodTubeStatePoll();
            const el = document.querySelector(`.mes[mesid="${index}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        $(document).off('click', '.nova-history-save-btn').on('click', '.nova-history-save-btn', function() {
            const index = $(this).data('index');
            const subindex = $(this).data('subindex');
            const newText = $(`.nova-history-textarea[data-index="${index}"][data-subindex="${subindex}"]`).val();
            const stContext = SillyTavern.getContext();
            if (stContext && stContext.chat && stContext.chat[index]) {
                const localRegex = contextMarkerRegex(true);
                let matches = [];
                let match;
                while ((match = localRegex.exec(stContext.chat[index].mes)) !== null) {
                    matches.push(match);
                }
                if (matches[subindex]) {
                    // Подпись берём из самого блока: правка не должна превращать
                    // дословную переписку в пересказ и наоборот
                    const kind = CONTEXT_KINDS[contextKindByLabel(matches[subindex][1])];
                    stContext.chat[index].mes = stContext.chat[index].mes.replace(
                        matches[subindex][0],
                        `\n<span class="nova-hidden-context" style="display:none;" title="NOVA Context">[${kind.label}: ${sanitizeContextPayload(newText)}]</span>\n`
                    );
                    stContext.saveChat();
                    if (typeof stContext.updateChatUI === 'function') stContext.updateChatUI();
                    toastr.success(`${kind.title}: изменения сохранены`);
                }
            }
        });

        $(document).off('click', '.nova-history-delete-btn').on('click', '.nova-history-delete-btn', function() {
            const index = $(this).data('index');
            const subindex = $(this).data('subindex');
            novaConfirm("Удалить этот блок из памяти чата?", () => {
                const stContext = SillyTavern.getContext();
                if (stContext && stContext.chat && stContext.chat[index]) {
                    const localRegex = contextMarkerRegex(true);
                    let matches = [];
                    let match;
                    while ((match = localRegex.exec(stContext.chat[index].mes)) !== null) {
                        matches.push(match);
                    }
                    if (matches[subindex]) {
                        const kind = CONTEXT_KINDS[contextKindByLabel(matches[subindex][1])];
                        stContext.chat[index].mes = stContext.chat[index].mes.replace(matches[subindex][0], '').trim();
                        stContext.saveChat();
                        if (typeof stContext.updateChatUI === 'function') stContext.updateChatUI();

                        // Снимаем метку только того вида, который удалили: вторая
                        // полоска относится к другому блоку и остаётся в силе
                        if (feedPosts && feedPosts.length > 0) feedPosts.forEach(p => delete p[kind.mark]);
                        if (dmThreads && dmThreads.length > 0) dmThreads.forEach(t => t.messages?.forEach(m => delete m[kind.mark]));
                        saveFeed();
                        renderFeed();
                        renderDMs();

                        toastr.success(`${kind.title}: блок удалён`);
                        renderHistoryTab();
                    }
                }
            });
        });

        $('#nova-thinking-budget').on('change', updateThinkingBadge);

        $('#nova-save-settings-btn').on('click', () => {
            const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
            if (!extensionSettings.NOVA) extensionSettings.NOVA = {};
            
            const selectedProfileName = $('#nova-proxy-list').val();
            extensionSettings.NOVA.connection_profile = selectedProfileName;
            // Запоминаем id — имя профиля пользователь может поменять в Connection Manager
            extensionSettings.NOVA.connection_profile_id = $('#nova-proxy-list option:selected').data('profile-id') || '';
            extensionSettings.NOVA.context_size = $('#nova-context-size').val();
            extensionSettings.NOVA.max_tokens = $('#nova-max-tokens').val();
            extensionSettings.NOVA.feed_history_size = $('#nova-feed-history-size').val();
            extensionSettings.NOVA.dm_history_size = $('#nova-dm-history-size').val();
            extensionSettings.NOVA.thinking_budget = $('#nova-thinking-budget').val();
            extensionSettings.NOVA.thinking_hint = $('#nova-thinking-hint').val();
            extensionSettings.NOVA.thinking_hint_enabled = $('#nova-thinking-hint-enabled').is(':checked');
            extensionSettings.NOVA.start_reply_with = $('#nova-start-reply-with').val();
            extensionSettings.NOVA.reasoning_prefix = $('#nova-reasoning-prefix').val();
            extensionSettings.NOVA.reasoning_suffix = $('#nova-reasoning-suffix').val();
            extensionSettings.NOVA.reasoning_auto_parse = $('#nova-reasoning-auto-parse').is(':checked');
            extensionSettings.NOVA.thinking_prompt = $('#nova-thinking-prompt').val();
            extensionSettings.NOVA.thinking_prompt_enabled = $('#nova-thinking-prompt-enabled').is(':checked');
            extensionSettings.NOVA.include_char_card = $('#nova-include-char-card').is(':checked');
            extensionSettings.NOVA.include_persona = $('#nova-include-user-persona').is(':checked');
            extensionSettings.NOVA.include_lorebooks = $('#nova-include-world-info').is(':checked');
            extensionSettings.NOVA.include_author_note = $('#nova-include-author-note').is(':checked');
            
            saveSettingsDebounced();
            toastr.success("Настройки NOVA сохранены");
        });
        
        $('#nova-refresh-feed-btn').on('click', () => {
            generateFeed();
        });

        $('#nova-feed-delete-btn').on('click', () => {
            $('#nova-delete-options-modal').css('display', 'flex').hide().fadeIn(200);
        });

        $('#nova-delete-cancel').on('click', () => {
            $('#nova-delete-options-modal').fadeOut(200);
        });

        $('#nova-delete-last-batch').on('click', () => {
            $('#nova-delete-options-modal').fadeOut(200);
            if (feedPosts.length === 0) return;
            const maxBatchId = Math.max(...feedPosts.map(p => p.batchId || 0));
            if (maxBatchId === 0 || !isFinite(maxBatchId)) {
                toastr.warning('Нет постов с известной генерацией (старые посты).');
                return;
            }
            feedPosts.filter(p => p.batchId === maxBatchId).forEach(revertRelationshipsDeep);
            feedPosts = feedPosts.filter(p => p.batchId !== maxBatchId);
            saveFeed();
            renderFeed();
            toastr.success('Последняя генерация удалена.');
        });

        $('#nova-delete-select-mode').on('click', () => {
            $('#nova-delete-options-modal').fadeOut(200);
            feedSelectMode = true;
            selectedFeedPosts.clear();
            renderFeed();
        });

        $('#nova-feed-cancel-select-btn').on('click', () => {
            feedSelectMode = false;
            selectedFeedPosts.clear();
            renderFeed();
        });

        $('#nova-feed-confirm-delete-btn').on('click', () => {
            if (selectedFeedPosts.size === 0) return;

            const label = pluralRu(selectedFeedPosts.size, 'пост', 'поста', 'постов');
            novaConfirm(`Удалить ${label} вместе со всеми ответами? Это действие необратимо.`, () => {
                // Delete from highest index to lowest to avoid shifting issues
                const indices = Array.from(selectedFeedPosts).sort((a, b) => b - a);
                indices.forEach(idx => {
                    revertRelationshipsDeep(feedPosts[idx]);
                    feedPosts.splice(idx, 1);
                });

                saveFeed();
                feedSelectMode = false;
                selectedFeedPosts.clear();
                renderFeed();
                toastr.success(`Удалено: ${label}.`);
            });
        });

        $('#nova-create-post-btn').on('click', () => {
            const stContext = SillyTavern.getContext();
            const activeProfiles = getActiveProfiles();
            const userProfile = activeProfiles.find(ap => ap.isUser) || { name: stContext.name1 || 'Вы', color: '#1da1f2' };
            const $avatar = $('#nova-create-post-avatar');
            if (userProfile.avatar) {
                $avatar.replaceWith(`<img id="nova-create-post-avatar" src="${userProfile.avatar}" class="nova-profile-avatar" style="width: 48px; height: 48px; min-width: 48px; border-radius: 50%; object-fit: cover;">`);
            } else {
                $avatar.replaceWith(`<div id="nova-create-post-avatar" class="nova-profile-avatar" style="width: 48px; height: 48px; min-width: 48px; background-color: ${userProfile.color || '#1da1f2'}; color: white; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; border-radius: 50%;">${(userProfile.name || '?').charAt(0).toUpperCase()}</div>`);
            }
            $('#nova-create-post-input').val('');
            $('#nova-create-post-submit').prop('disabled', true);
            $('#nova-view-create-post').addClass('active');
            setTimeout(() => $('#nova-create-post-input').focus(), 100);
        });

        $('#nova-create-post-cancel').on('click', () => {
            $('#nova-view-create-post').removeClass('active');
            clearPendingImage('post');
        });

        // Пост можно опубликовать и без текста, если приложена картинка
        function syncCreatePostSubmit() {
            const hasText = $('#nova-create-post-input').val().trim().length > 0;
            $('#nova-create-post-submit').prop('disabled', !hasText && !pendingImages.post);
        }

        $('#nova-create-post-input').on('input', syncCreatePostSubmit);

        $('#nova-create-post-attach').on('click', () => $('#nova-create-post-image-input').trigger('click'));
        $('#nova-create-post-image-input').on('change', async function() {
            await attachPendingImage('post', this.files?.[0], '#nova-create-post-image-preview');
            this.value = '';
            syncCreatePostSubmit();
        });
        $('#nova-create-post-image-preview').on('click', '.nova-image-remove', () => {
            clearPendingImage('post');
            syncCreatePostSubmit();
        });

        $('#nova-create-post-submit').on('click', async () => {
            const text = $('#nova-create-post-input').val().trim();
            const image = pendingImages.post;
            if (!text && !image) return;

            const $btn = $('#nova-create-post-submit').prop('disabled', true);
            let imagePath = '';
            let imageThumb = '';
            if (image) {
                try {
                    const uploaded = await uploadNovaImageWithThumbnail(image);
                    imagePath = uploaded.image;
                    imageThumb = uploaded.thumbnail;
                } catch (e) {
                    console.error('[NOVA] Не удалось загрузить изображение', e);
                    toastr.error('Не удалось загрузить изображение: ' + (e.message || ''));
                    $btn.prop('disabled', false);
                    return;
                }
            }

            $('#nova-view-create-post').removeClass('active');
            clearPendingImage('post');
            $btn.prop('disabled', false);

            generateFeed(text, { imagePath, imageThumb, imageDataUrl: image });
        });

        $('#nova-context-size').on('input', function() {
            $('#nova-context-size-val').text($(this).val());
        });
        
        $('#nova-max-tokens').on('input', function() {
            const val = $(this).val();
            $('#nova-max-tokens-val').text(val === '0' ? '0 (Авто)' : val);
        });

        $('#nova-feed-history-size').on('input', function() {
            const val = $(this).val();
            $('#nova-feed-history-size-val').text(val === '0' ? 'без лимита' : val);
        });

        $('#nova-dm-history-size').on('input', function() {
            const val = $(this).val();
            $('#nova-dm-history-size-val').text(val === '0' ? 'без лимита' : val);
        });

        $('#nova-new-dm-back-btn').on('click', () => {
            $('#nova-view-new-dm-overlay').removeClass('active');
        });

        $('#nova-overlay-back-btn, .nova-overlay-back').on('click', function() {
            const $overlay = $(this).closest('.nova-folder-overlay');
            $overlay.removeClass('active');
            // Уходим из переписки — снимаем её тему, иначе её цвета останутся на
            // модалках подтверждения в ленте и других вкладках
            if ($overlay.attr('id') === 'nova-view-single-dm') clearDMThemeVars();
        });

        // Раскрытие/выбор в выпадающем списке персон
        wireCustomSelects($('#nova-view-chars'));

        $(document).on('click', '#nova-create-persona-btn', async () => {
            const name = await novaPrompt('Новая персона', 'Название (необязательно)');
            if (name === null) return;
            const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
            if (!extensionSettings.NOVA) extensionSettings.NOVA = {};
            const store = extensionSettings.NOVA;
            if (!Array.isArray(store.personas)) store.personas = [];
            if (!store.charProfiles) store.charProfiles = {};
            const id = `persona_${Date.now()}`;
            // Не привязана ни к какой персоне Таверны — самостоятельная, для ручного
            // переключения. Привязывается автоматически, если вдруг совпадёт по аватарке
            store.personas.push({ id, avatarId: null });
            if (name && name.trim()) store.charProfiles[id] = { name: name.trim() };
            store.activePersonaId = id;
            saveSettingsDebounced();
            renderCharsTab();
            toastr.success('Персона создана');
        });

        $(document).off('click.novaPersonaList').on('click.novaPersonaList', '#nova-persona-list .nova-select-option', function() {
            const id = String($(this).data('value') || '');
            const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
            if (!id || id === extensionSettings.NOVA?.activePersonaId) return;
            if (!extensionSettings.NOVA) extensionSettings.NOVA = {};
            extensionSettings.NOVA.activePersonaId = id;
            saveSettingsDebounced();
            renderCharsTab();
        });

        $(document).on('click', '#nova-persona-delete-btn', () => {
            const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
            const store = extensionSettings.NOVA || {};
            const personaId = store.activePersonaId || getActivePersonaEntry()?.id;
            if (!personaId) return;
            novaConfirm('Удалить эту персону? Профиль (имя, ник, био) будет потерян.', () => {
                store.personas = (store.personas || []).filter(p => p.id !== personaId);
                if (store.charProfiles) delete store.charProfiles[personaId];
                if (store.activePersonaId === personaId) store.activePersonaId = '';
                saveSettingsDebounced();
                renderCharsTab();
            });
        });

        $(document).on('click', '#nova-create-folder-btn', async () => {
            const folderName = await Popup.show.input('Новая папка', 'Название папки');
            if (folderName) {
                const stContext = SillyTavern.getContext();
                const newFolder = {
                    id: 'folder_' + Date.now(),
                    name: folderName,
                    icon: 'fa-folder',
                    active: true,
                    chatIds: [stContext.chatId],
                    npcs: []
                };
                customFolders.push(newFolder);
                saveFolders();
                renderProfilesTab();
                toastr.success(`Папка "${folderName}" создана`);
            }
        });

        $(document).on('click', '#nova-generate-npc-btn', () => {
            generateNPCFolder();
        });
        
        // Manual NPC Creation
        $('#nova-create-manual-npc-btn').on('click', () => {
            openNpcEditor(null, currentOpenFolderId || 'default');
        });

        $('#nova-create-npc-back-btn').on('click', () => {
            $('#nova-view-create-npc').removeClass('active');
        });

        $('#nova-create-npc-avatar-wrapper').on('click', () => {
            $('#nova-create-npc-avatar-input').click();
        });

        $('#nova-create-npc-avatar-input').on('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            openImageCropper(file, { aspect: 1, outWidth: 256, allowShape: true, title: 'Выберите область для аватарки' }, async (dataUrl) => {
                // Превью сразу из data URL, путь подставляем после загрузки — иначе
                // картинка «залипает» пустой на время обращения к серверу
                npcEditorState.avatar = dataUrl;
                renderNpcEditorAvatar();
                npcEditorState.avatar = await storeProfileImage(dataUrl);
                renderNpcEditorAvatar();
            });
            $(this).val('');
        });

        $('#nova-create-npc-banner-wrapper').on('click', (e) => {
            if ($(e.target).closest('#nova-create-npc-banner-clear').length) return;
            $('#nova-create-npc-banner-input').click();
        });

        $('#nova-create-npc-banner-input').on('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            openImageCropper(file, { aspect: 3, outWidth: 900, title: 'Выберите область для шапки' }, async (dataUrl) => {
                // См. аватарку выше — сначала превью, потом путь
                npcEditorState.banner = dataUrl;
                renderNpcEditorBanner();
                npcEditorState.banner = await storeProfileImage(dataUrl);
                renderNpcEditorBanner();
            });
            $(this).val('');
        });

        $('#nova-create-npc-banner-clear').on('click', (e) => {
            e.stopPropagation();
            npcEditorState.banner = null;
            $('#nova-create-npc-banner-input').val('');
            renderNpcEditorBanner();
        });

        $('#nova-create-npc-avatar-clear').on('click', (e) => {
            e.stopPropagation();
            npcEditorState.avatar = null;
            $('#nova-create-npc-avatar-input').val('');
            renderNpcEditorAvatar();
        });

        // Заглушка аватара живёт по имени и цвету
        $('#nova-create-npc-color').on('input', renderNpcEditorAvatar);
        $('#nova-create-npc-name').on('input', renderNpcEditorAvatar);

        $('#nova-save-manual-npc-btn').on('click', saveNpcFromEditor);

        $('#nova-delete-npc-btn').on('click', async () => {
            if (!npcEditorState.npc) return;
            await deleteNpc(npcEditorState.npc, () => {
                $('#nova-view-create-npc').removeClass('active');
                renderProfilesTab();
                const openFolder = getAllFolders().find(f => f.id === currentOpenFolderId);
                if (openFolder && $('#nova-view-folder-overlay').hasClass('active')) openFolderOverlay(openFolder);
            });
        });

        // Archive
        $('#nova-archive-btn').on('click', () => {
            $('#nova-view-archive').addClass('active');
        });
        $('#nova-archive-back-btn').on('click', () => {
            $('#nova-view-archive').removeClass('active');
        });

        // Настройки генерации изображений — теперь отдельный экран, открывается
        // из галереи, а не свёрнутая секция среди общих настроек
        $('#nova-gallery-image-settings-btn').on('click', () => {
            renderImageSettings();
            $('#nova-view-image-settings').addClass('active');
            // Только теперь экран виден и высоту растущих полей можно измерить:
            // renderImageSettings подставляет в них текст, пока всё ещё скрыто
            // (scrollHeight = 0), и сама подогнать высоту не может
            $('#nova-view-image-settings textarea.nova-autogrow').each(function() { autoGrowTextarea(this); });
        });
        $('#nova-image-settings-back-btn').on('click', () => {
            $('#nova-view-image-settings').removeClass('active');
        });

        $('#nova-folder-back-btn').on('click', () => {
            closeNpcActionsMenu();
            $('#nova-view-folder-overlay').removeClass('active');
            npcSelectMode = false;
            selectedNpcIds.clear();
            currentOpenFolderId = null;
            $('#nova-folder-bulk-bar').hide();
            $('#nova-folder-select-mode-btn').css('background', 'var(--nova-surface-hover)');
        });
        
        $('#nova-public-profile-back-btn').off('click').on('click', () => {
            $('#nova-view-public-profile').removeClass('active');
        });
        
        $('#nova-single-post-back-btn').off('click').on('click', () => {
            $('#nova-view-single-post').removeClass('active');
            replySelectMode = false;
            selectedReplyKeys.clear();
            currentSinglePostIndex = null;
        });

        $('#nova-reply-select-mode-btn').on('click', () => {
            if (currentSinglePostIndex === null) return;
            replySelectMode = true;
            selectedReplyKeys.clear();
            openSinglePost(currentSinglePostIndex);
        });

        $('#nova-reply-cancel-select-btn').on('click', () => {
            replySelectMode = false;
            selectedReplyKeys.clear();
            if (currentSinglePostIndex !== null) openSinglePost(currentSinglePostIndex);
        });

        $('#nova-reply-confirm-delete-btn').on('click', () => {
            if (selectedReplyKeys.size === 0 || currentSinglePostIndex === null) return;
            const postIndex = currentSinglePostIndex;
            const post = feedPosts[postIndex];
            if (!post) return;

            const label = pluralRu(selectedReplyKeys.size, 'ответ', 'ответа', 'ответов');
            novaConfirm(`Удалить ${label} вместе со всеми вложенными? Это действие необратимо.`, () => {
                // Глубже — раньше: если сначала убрать родителя, путь до отдельно
                // выбранного потомка станет невалидным ДО того, как мы до него дойдём
                const paths = Array.from(selectedReplyKeys)
                    .map(k => k.split(',').filter(Boolean).map(Number))
                    .filter(p => p.length > 0)
                    .sort((a, b) => {
                        if (a.length !== b.length) return b.length - a.length;
                        for (let i = 0; i < a.length; i++) {
                            if (a[i] !== b[i]) return b[i] - a[i];
                        }
                        return 0;
                    });

                paths.forEach(path => {
                    let arr = post.replies;
                    for (let i = 0; i < path.length - 1; i++) {
                        arr = arr?.[path[i]]?.replies;
                    }
                    if (!arr) return;
                    const idx = path[path.length - 1];
                    if (idx >= 0 && idx < arr.length) {
                        revertRelationshipsDeep(arr[idx]);
                        arr.splice(idx, 1);
                    }
                });

                saveFeed();
                replySelectMode = false;
                selectedReplyKeys.clear();
                openSinglePost(postIndex);
                renderFeed();
                toastr.success(`Удалено: ${label}.`);
            });
        });

        $('.nova-profile-tab').off('click').on('click', function() {
            $('.nova-profile-tab').removeClass('active').css('color', 'var(--nova-text-muted)');
            $('.nova-profile-tab-indicator').hide();
            
            $(this).addClass('active').css('color', 'var(--nova-text)');
            $(this).find('.nova-profile-tab-indicator').show();
        });
    }

    // Текущий уровень рассуждений — в шапке свёрнутой секции, чтобы не разворачивать ради проверки
    function updateThinkingBadge() {
        $('#nova-thinking-badge').text($('#nova-thinking-budget option:selected').text() || '');
    }

    // ─── UI генерации изображений ─────────────────────────────────────────────

    function updateImageBadge() {
        const cfg = getImageSettings();
        const profile = getActiveImageProfile();
        let text = 'Выключено';
        if (cfg.enabled && !profile) text = 'Нет профиля';
        else if (cfg.enabled) text = `До ${cfg.max_per_batch} за раз`;
        $('#nova-image-badge').text(text);
    }

    /** Перерисовывает выпадающие списки профилей и пресетов и подставляет их поля в редакторы. */
    function renderImageSettings() {
        const cfg = getImageSettings();

        $('#nova-image-enabled').prop('checked', !!cfg.enabled);
        $('#nova-image-max').val(cfg.max_per_batch);
        $('#nova-image-max-val').text(cfg.max_per_batch);

        const active = getActiveImageProfile();

        // Все списки — через свой компонент: нативный <select> на телефоне
        // открывается системным пикером и выпадает из оформления расширения
        $('#nova-image-profile-select-wrap').html(buildCustomSelect(
            'nova-image-profile-list',
            cfg.profiles.length
                ? cfg.profiles.map(p => ({ value: p.id, label: escapeHtml(p.name || 'Без названия') }))
                : [{ value: '', label: '— нет профилей, создайте —' }],
            cfg.active_profile || cfg.profiles[0]?.id || '',
        ));
        // Подключение может быть заимствовано — тогда свой редактор не нужен вовсе
        const borrowed = cfg.use_sillyimages ? readSillyImagesProfile() : null;
        $('#nova-image-use-sillyimages').prop('checked', !!cfg.use_sillyimages);
        $('#nova-image-own-profile').css('display', cfg.use_sillyimages ? 'none' : 'flex');
        const $info = $('#nova-image-sillyimages-info');
        if (cfg.use_sillyimages) {
            $info.css('display', 'block').html(borrowed
                ? `Подключение взято из sillyimages:<br>
                   тип <b>${escapeHtml(borrowed.apiType)}</b>, модель <b>${escapeHtml(borrowed.model || '—')}</b><br>
                   <span style="opacity:.7;">${escapeHtml(borrowed.endpoint)}</span><br>
                   Менять их нужно там же, в настройках sillyimages.`
                : 'Расширение sillyimages не найдено или в нём не заполнены эндпоинт и ключ. '
                  + 'Настройте его либо снимите галочку и заведите профиль здесь.');
        } else {
            $info.css('display', 'none');
        }

        $('#nova-image-profile-editor').css('display', active && !cfg.use_sillyimages ? 'block' : 'none');

        const type = ['gemini', 'naistera'].includes(active?.apiType) ? active.apiType : 'openai';
        $('#nova-image-type-select-wrap').html(buildCustomSelect('nova-image-profile-type', [
            { value: 'openai', label: 'OpenAI-совместимый' },
            { value: 'gemini', label: 'Gemini / nano-banana' },
            { value: 'naistera', label: 'Naistera' },
        ], type));

        renderModelSelect(active);

        $('#nova-image-aspect-select-wrap').html(buildCustomSelect(
            'nova-image-profile-aspect',
            NOVA_ASPECT_RATIOS.map(v => ({ value: v, label: v })),
            NOVA_ASPECT_RATIOS.includes(active?.aspect_ratio) ? active.aspect_ratio : '1:1',
        ));
        $('#nova-image-imagesize-select-wrap').html(buildCustomSelect(
            'nova-image-profile-imagesize',
            ['1K', '2K', '4K'].map(v => ({ value: v, label: v })),
            active?.image_size || '1K',
        ));

        if (active) {
            $('#nova-image-profile-name').val(active.name || '');
            $('#nova-image-profile-endpoint').val(active.endpoint || '');
            $('#nova-image-profile-key').val(active.apiKey || '');
        }
        updateImageTypeRows();

        const preset = getActiveImagePreset();
        $('#nova-image-preset-select-wrap').html(buildCustomSelect(
            'nova-image-preset-list',
            cfg.presets.map(p => ({ value: p.id, label: escapeHtml(p.name || 'Без названия') })),
            preset?.id || '',
        ));
        if (preset) {
            $('#nova-image-preset-name').val(preset.name || '');
            $('#nova-image-preset-prompt').val(preset.prompt || '');
        }

        const style = getActiveImageStyle();
        $('#nova-image-style-select-wrap').html(buildCustomSelect(
            'nova-image-style-list',
            cfg.styles.map(s => ({ value: s.id, label: escapeHtml(s.name || 'Без названия') })),
            style?.id || '',
        ));
        if (style) {
            $('#nova-image-style-name').val(style.name || '');
            // .val() не порождает input — высоту после подстановки пресета ставим сами
            $('#nova-image-style-text').val(style.style || '').each(function() { autoGrowTextarea(this); });
            $('#nova-image-style-thumb').html(style.preview
                ? `<img src="${escapeHtml(style.preview)}" alt="">`
                : '<i class="fa-solid fa-image"></i>');
        }

        renderPhotoPermissions();
        renderReferenceSlots();
        updateImageBadge();
    }

    // Списки моделей, подтянутые с провайдера, по id профиля. Живут до перезагрузки:
    // дёргать /v1/models на каждую перерисовку настроек незачем
    const imageModelCache = new Map();

    /** Модель — списком. Пока список не подтянут, показываем то, что уже выбрано. */
    function renderModelSelect(profile) {
        const $wrap = $('#nova-image-model-select-wrap');
        if (!$wrap.length) return;

        const current = String(profile?.model || '').trim();
        let list = profile?.apiType === 'naistera'
            ? NAISTERA_MODELS.slice()
            : (imageModelCache.get(profile?.id) || []);

        // Сохранённая модель может не встретиться в списке — не теряем её
        if (current && !list.includes(current)) list = [current, ...list];

        const $hint = $('#nova-image-model-hint');
        if (!list.length) {
            $wrap.html(buildCustomSelect('nova-image-profile-model', [{ value: '', label: '— нажмите обновить —' }], ''));
            $hint.text('Заполните URL и ключ, затем нажмите кнопку обновления рядом.');
        } else {
            $wrap.html(buildCustomSelect('nova-image-profile-model', list.map(m => ({ value: m, label: escapeHtml(m) })), current || list[0]));
            $hint.text(profile?.apiType === 'naistera'
                ? 'Список моделей Naistera фиксированный.'
                : `Загружено моделей: ${list.length}.`);
        }
    }

    /**
     * Список «кому можно фото» — ровно те, кто участвует в ТЕКУЩЕМ чате:
     * персонажи карточки/группы плюс NPC из активных папок этого чата.
     *
     * Сам запрет хранится по хэндлам и НЕ чистится при смене чата: иначе,
     * заглянув в другой чат, вы бы потеряли расставленные тут галочки.
     * Запись про персонажа из другого чата просто не показывается.
     */
    function renderPhotoPermissions() {
        const $box = $('#nova-photo-permissions');
        if (!$box.length) return;
        $box.empty();

        const profiles = getActiveProfiles().filter(p => !p.isUser);
        if (!profiles.length) {
            $box.append(`<div style="color: var(--nova-text-muted); font-size: 13px; opacity: 0.75; padding: 4px 0;">
                Нет активных персонажей и NPC.
            </div>`);
            return;
        }

        profiles.forEach(p => {
            const handle = normHandle(p.handle);
            const allowed = canAttachPhoto(p.handle);
            $box.append(`
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 5px 0; min-width: 0;">
                    <input type="checkbox" class="nova-photo-allow" data-handle="${escapeHtml(handle)}" ${allowed ? 'checked' : ''} style="accent-color: var(--nova-accent); width: 17px; height: 17px; flex-shrink: 0;">
                    <span class="nova-truncate" style="font-size: 14px;">${escapeHtml(p.name)}</span>
                    <span class="nova-truncate" style="font-size: 12px; color: var(--nova-text-muted); flex-shrink: 1;">${escapeHtml(p.handle)}</span>
                </label>
            `);
        });
    }

    function setPhotoAllowed(handle, allowed) {
        const cfg = getImageSettings();
        const key = normHandle(handle);
        const blocked = new Set(cfg.photo_blocked.map(normHandle).filter(Boolean));
        if (allowed) blocked.delete(key);
        else blocked.add(key);
        cfg.photo_blocked = Array.from(blocked);
        saveImageSettings();
    }

    function bindPhotoPermissionEvents() {
        $(document).on('change', '.nova-photo-allow', function() {
            setPhotoAllowed($(this).data('handle'), $(this).is(':checked'));
        });

        $('#nova-photo-allow-all').on('click', () => {
            const cfg = getImageSettings();
            // Чистим весь запрет, а не только видимых: заодно уходят хвосты от старых чатов
            cfg.photo_blocked = [];
            saveImageSettings();
            renderPhotoPermissions();
        });

        $('#nova-photo-deny-all').on('click', () => {
            getActiveProfiles().filter(p => !p.isUser).forEach(p => setPhotoAllowed(p.handle, false));
            renderPhotoPermissions();
        });
    }

    // Какой слот сейчас ждёт файл: один input[type=file] обслуживает и добавление,
    // и замену картинки в существующем референсе
    let pendingRefSlotId = null;

    /**
     * Короткая сводка для свёрнутой карточки: по ней референс должен опознаваться
     * не разворачивая — иначе список из десятка одинаковых полосок бесполезен.
     */
    function describeReferenceBinding(ref, profiles) {
        const bound = ref.handles[0] || '';
        if (!bound) return '';
        const profile = profiles.find(p => normHandle(p.handle) === bound);
        return profile ? profile.name : `@${bound}`;
    }

    function buildReferenceCard(ref, profiles) {
        const bound = ref.handles[0] || '';
        const inChat = profiles.some(p => normHandle(p.handle) === bound);

        // Привязка к персонажу из ДРУГОГО чата — не ошибка: референс Нанами
        // работает везде, где он постит. Но молча показывать «не привязан»
        // нельзя, иначе интерфейс врёт про сохранённое состояние
        const options = ['<option value="">— не привязан —</option>']
            .concat(bound && !inChat
                ? [`<option value="${escapeHtml(bound)}" selected>@${escapeHtml(bound)} — нет в этом чате</option>`]
                : [])
            .concat(profiles.map(p => {
                const selected = normHandle(p.handle) === bound ? ' selected' : '';
                return `<option value="${escapeHtml(normHandle(p.handle))}"${selected}>${escapeHtml(p.name)} (${escapeHtml(p.handle)})</option>`;
            }))
            .join('');

        const title = ref.name || 'Без имени';
        const boundLabel = describeReferenceBinding(ref, profiles);
        const chips = [
            ref.mode === 'always'
                ? '<span class="nova-ref-chip accent">Всегда</span>'
                : '<span class="nova-ref-chip">Когда в кадре</span>',
            boundLabel ? `<span class="nova-ref-chip">${escapeHtml(boundLabel)}</span>` : '',
            ref.keywords.length ? `<span class="nova-ref-chip">${ref.keywords.length} кл. слов</span>` : '',
        ].join('');

        return `
            <details class="nova-ref-item" data-id="${ref.id}">
                <summary class="nova-ref-summary">
                    <div class="nova-ref-mini">${ref.image
                        ? `<img src="${escapeHtml(ref.image)}" alt="">`
                        : '<i class="fa-solid fa-image"></i>'}</div>
                    <div class="nova-ref-summary-text">
                        <div class="nova-ref-title nova-truncate">${escapeHtml(title)}</div>
                        <div class="nova-ref-chips">${chips}</div>
                    </div>
                    <i class="fa-solid fa-chevron-right nova-ref-chevron"></i>
                </summary>
                <div class="nova-ref-card" data-id="${ref.id}">
                    <div class="nova-ref-thumb" title="Заменить изображение">
                        ${ref.image ? `<img src="${escapeHtml(ref.image)}" alt="">` : '<i class="fa-solid fa-image"></i>'}
                    </div>
                    <div class="nova-ref-fields">
                        <input type="text" class="nova-image-field nova-ref-name" placeholder="Имя (подписывается на картинке)" value="${escapeHtml(ref.name)}">
                        <select class="nova-image-field nova-ref-handle" style="appearance: auto; cursor: pointer;">${options}</select>
                        <textarea class="nova-image-field nova-autogrow nova-ref-keywords" rows="1" placeholder="Ключевые слова через запятую">${escapeHtml(ref.keywords.join(', '))}</textarea>
                        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                            <select class="nova-image-field nova-ref-mode" style="flex: 1; min-width: 130px; appearance: auto; cursor: pointer;">
                                <option value="auto"${ref.mode === 'auto' ? ' selected' : ''}>Когда в кадре</option>
                                <option value="always"${ref.mode === 'always' ? ' selected' : ''}>Всегда</option>
                            </select>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--nova-text-muted); font-size: 13px;">
                                <input type="checkbox" class="nova-ref-label" ${ref.label ? 'checked' : ''} style="accent-color: var(--nova-accent); width: 16px; height: 16px;">
                                Подпись
                            </label>
                            <div class="nova-icon-btn nova-ref-archive" title="Убрать в архив" style="background: var(--nova-surface-hover); width: 32px; height: 32px;">
                                <i class="fa-solid fa-box-archive"></i>
                            </div>
                            <div class="nova-icon-btn nova-ref-delete" title="Удалить референс" style="background: var(--nova-surface-hover); width: 32px; height: 32px;">
                                <i class="fa-solid fa-trash"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </details>
        `;
    }

    function renderReferenceSlots() {
        const $list = $('#nova-image-refs-list');
        if (!$list.length) return;

        const cfg = getImageSettings();
        const all = getReferences();
        const active = all.filter(r => !r.archived);
        const archived = all.filter(r => r.archived);
        $('#nova-image-refs-enabled').prop('checked', cfg.references_enabled !== false);
        $list.empty();

        const profiles = getActiveProfiles();

        if (!active.length) {
            $list.append(`<div style="color: var(--nova-text-muted); font-size: 13px; opacity: 0.75; padding: 4px 0;">
                ${archived.length
                    ? 'Все референсы в архиве. Верните нужный ниже или загрузите новый.'
                    : 'Референсов пока нет. Загрузите фото персонажа, чтобы он выглядел одинаково на всех картинках.'}
            </div>`);
        } else {
            active.forEach(ref => $list.append(buildReferenceCard(ref, profiles)));
        }

        renderReferenceArchive(archived, profiles);
    }

    function renderReferenceArchive(archived, profiles) {
        const $wrap = $('#nova-image-refs-archive-wrap');
        const $box = $('#nova-image-refs-archive');
        if (!$wrap.length || !$box.length) return;

        // Пустой архив не показываем вовсе — пока туда ничего не убирали,
        // лишний раздел в настройках только мешает
        $wrap.toggle(archived.length > 0);
        $('#nova-image-refs-archive-count').text(archived.length || '');
        $box.empty();

        archived.forEach(ref => {
            const boundLabel = describeReferenceBinding(ref, profiles);
            $box.append(`
                <div class="nova-ref-archived" data-id="${ref.id}">
                    <div class="nova-ref-mini">${ref.image
                        ? `<img src="${escapeHtml(ref.image)}" alt="">`
                        : '<i class="fa-solid fa-image"></i>'}</div>
                    <div class="nova-ref-summary-text">
                        <div class="nova-ref-title nova-truncate">${escapeHtml(ref.name || 'Без имени')}</div>
                        <div class="nova-ref-chips">${boundLabel ? `<span class="nova-ref-chip">${escapeHtml(boundLabel)}</span>` : ''}</div>
                    </div>
                    <div class="nova-icon-btn nova-ref-restore" title="Вернуть в работу" style="background: var(--nova-surface-hover); width: 32px; height: 32px; flex-shrink: 0;">
                        <i class="fa-solid fa-rotate-left"></i>
                    </div>
                    <div class="nova-icon-btn nova-ref-delete" title="Удалить навсегда" style="background: var(--nova-surface-hover); width: 32px; height: 32px; flex-shrink: 0;">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                </div>
            `);
        });
    }

    function bindReferenceEvents() {
        // Ссылка на слот берётся и из редактируемой карточки, и из строки архива —
        // у них разная разметка, но кнопка удаления общая
        const findRef = el => {
            const id = $(el).closest('.nova-ref-card, .nova-ref-archived').data('id');
            return getReferences().find(r => r.id === id) || null;
        };
        const commit = () => { saveImageSettings(); };

        $('#nova-image-refs-enabled').on('change', function() {
            getImageSettings().references_enabled = $(this).is(':checked');
            commit();
        });

        // Добавление и замена идут через один input: новый слот создаётся только
        // после того, как файл реально выбран, иначе в списке копятся пустышки
        $('#nova-image-ref-add').on('click', () => {
            pendingRefSlotId = null;
            $('#nova-image-ref-file').trigger('click');
        });

        // Селектор привязан к списку референсов не для красоты: превью стиля
        // (#nova-image-style-thumb) переиспользует и класс .nova-ref-thumb, и
        // обёртку .nova-ref-card, поэтому без этой привязки клик по нему открывал
        // ДВА диалога выбора файла разом — свой и этот, — а выбранная картинка
        // заодно создавала пустой референс на ровном месте
        $(document).on('click', '#nova-image-refs-list .nova-ref-thumb', function() {
            pendingRefSlotId = $(this).closest('.nova-ref-card').data('id');
            $('#nova-image-ref-file').trigger('click');
        });

        $('#nova-image-ref-file').on('change', async function() {
            const file = this.files?.[0];
            this.value = '';
            if (!file) return;

            try {
                // 768px хватает, чтобы модель разобрала лицо, и не раздувает папку
                const dataUrl = await compressImageFile(file, 768, 0.85);
                const path = await uploadNovaImage(dataUrl);
                const cfg = getImageSettings();

                let addedId = '';
                if (pendingRefSlotId) {
                    const ref = getReferences().find(r => r.id === pendingRefSlotId);
                    if (ref) ref.image = path;
                } else {
                    const added = normalizeReference({ name: '', image: path, mode: 'auto' });
                    cfg.references.push(added);
                    addedId = added.id;
                }
                commit();
                renderReferenceSlots();
                // Карточки теперь свёрнуты — только что добавленную сразу раскрываем
                // и ставим курсор в имя, иначе после загрузки фото пришлось бы ещё
                // искать и разворачивать безымянный слот вручную
                if (addedId) {
                    const $added = $(`.nova-ref-item[data-id="${addedId}"]`).prop('open', true);
                    $added.find('.nova-ref-name').trigger('focus');
                    $added.find('textarea.nova-autogrow').each(function() { autoGrowTextarea(this); });
                }
            } catch (e) {
                console.error('[NOVA] Не удалось загрузить референс', e);
                toastr.error('Не удалось загрузить референс: ' + (e.message || ''));
            } finally {
                pendingRefSlotId = null;
            }
        });

        $(document).on('change', '.nova-ref-name', function() {
            const ref = findRef(this);
            if (ref) { ref.name = $(this).val().trim(); commit(); }
        });

        $(document).on('change', '.nova-ref-handle', function() {
            const ref = findRef(this);
            if (!ref) return;
            const handle = normHandle($(this).val());
            ref.handles = handle ? [handle] : [];
            commit();
        });

        $(document).on('change', '.nova-ref-keywords', function() {
            const ref = findRef(this);
            if (!ref) return;
            ref.keywords = String($(this).val()).split(',').map(k => k.trim()).filter(Boolean);
            commit();
        });

        $(document).on('change', '.nova-ref-mode', function() {
            const ref = findRef(this);
            if (ref) { ref.mode = $(this).val() === 'always' ? 'always' : 'auto'; commit(); }
        });

        $(document).on('change', '.nova-ref-label', function() {
            const ref = findRef(this);
            if (ref) { ref.label = $(this).is(':checked'); commit(); }
        });

        // Пока карточка свёрнута, у полей внутри scrollHeight = 0 и автовысоту
        // посчитать нельзя (см. autoGrowTextarea). Событие toggle у <details> не
        // всплывает, поэтому ловим клик по шапке и меряем уже после разворота.
        $(document).on('click', '.nova-ref-summary', function() {
            const $item = $(this).closest('.nova-ref-item');
            requestAnimationFrame(() => {
                if (!$item.prop('open')) return;
                $item.find('textarea.nova-autogrow').each(function() { autoGrowTextarea(this); });
            });
        });

        $(document).on('click', '.nova-ref-archive', function() {
            const ref = findRef(this);
            if (!ref) return;
            // Без подтверждения: действие обратимо одним нажатием в архиве,
            // в отличие от удаления
            ref.archived = true;
            commit();
            renderReferenceSlots();
            toastr.info(`«${ref.name || 'Без имени'}» — в архиве.`);
        });

        $(document).on('click', '.nova-ref-restore', function() {
            const ref = findRef(this);
            if (!ref) return;
            ref.archived = false;
            commit();
            renderReferenceSlots();
        });

        $(document).on('click', '.nova-ref-delete', function() {
            const ref = findRef(this);
            if (!ref) return;
            novaConfirm(`Удалить референс${ref.name ? ` «${ref.name}»` : ''}?`, () => {
                const cfg = getImageSettings();
                cfg.references = cfg.references.filter(r => r.id !== ref.id);
                commit();
                renderReferenceSlots();
            });
        });
    }

    /** Размер против соотношения сторон — у двух типов API поля разные. */
    function updateImageTypeRows() {
        const type = String($('#nova-image-profile-type').attr('data-value') || 'openai');
        // Соотношение сторон есть и у Gemini, и у Naistera; попиксельный размер — только у OpenAI.
        // Разрешение (1K/2K/4K) понимает лишь Gemini
        const hasAspect = type === 'gemini' || type === 'naistera';
        $('#nova-image-gemini-rows').css('display', hasAspect ? 'flex' : 'none');
        $('#nova-image-imagesize-row').css('display', type === 'gemini' ? 'flex' : 'none');
        $('#nova-image-size-row').css('display', hasAspect ? 'none' : 'flex');
    }

    function bindImageSettingsEvents() {
        $('#nova-image-use-sillyimages').on('change', function() {
            const cfg = getImageSettings();
            cfg.use_sillyimages = $(this).is(':checked');
            if (cfg.use_sillyimages && !readSillyImagesProfile()) {
                toastr.warning('В sillyimages не заполнены эндпоинт и ключ — брать оттуда пока нечего.', 'NOVA');
            }
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-enabled').on('change', function() {
            const cfg = getImageSettings();
            cfg.enabled = $(this).is(':checked');
            if (cfg.enabled && !getActiveImageProfile()) {
                toastr.warning('Сначала создайте профиль подключения для картинок.', 'NOVA');
            }
            saveImageSettings();
            updateImageBadge();
        });

        $('#nova-image-max').on('input', function() {
            const cfg = getImageSettings();
            cfg.max_per_batch = parseInt($(this).val(), 10) || 1;
            $('#nova-image-max-val').text(cfg.max_per_batch);
            saveImageSettings();
            updateImageBadge();
        });

        // Раскрытие/выбор в кастомных списках блока картинок. Экран генерации
        // изображений — ОТДЕЛЬНЫЙ оверлей (#nova-view-image-settings), а не часть
        // вкладки "Настройки" (#nova-view-settings, в которой вообще нет кастомных
        // списков) — из-за этой опечатки в ID триггер списков ни разу не получал
        // класс .open, и все 7 выпадающих списков на этом экране (профиль, тип,
        // модель, соотношение сторон, размер, пресет, стиль) не открывались по клику
        wireCustomSelects($('#nova-view-image-settings'));

        $('#nova-image-model-refresh').on('click', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;

            // Тянем по тому, что сейчас в полях, а не по сохранённому профилю:
            // иначе сначала пришлось бы сохранять, а потом обновлять
            const cfg = getImageSettings();
            const active = getActiveImageProfile();
            const draft = {
                id: active?.id || '__draft',
                apiType: String($('#nova-image-profile-type').attr('data-value') || 'openai'),
                endpoint: $('#nova-image-profile-endpoint').val().trim() || active?.endpoint || '',
                apiKey: $('#nova-image-profile-key').val().trim() || active?.apiKey || '',
                model: String($('#nova-image-profile-model').attr('data-value') || ''),
            };

            $btn.prop('disabled', true).find('i').addClass('fa-spin');
            try {
                const models = await fetchImageModels(draft);
                imageModelCache.set(draft.id, models);
                renderModelSelect({ ...draft, model: draft.model || models[0] });
                toastr.success(`Загружено моделей: ${models.length}`, 'NOVA');
            } catch (e) {
                console.error('[NOVA] Не удалось получить список моделей', e);
                toastr.error(String(e.message || e), 'NOVA', { timeOut: 12000 });
            } finally {
                $btn.prop('disabled', false).find('i').removeClass('fa-spin');
            }
        });

        // Кастомный список — это div: значение лежит в data-value, а событие
        // приходит от клика по пункту, а не от change нативного <select>
        $(document).off('click.novaImgType').on('click.novaImgType', '#nova-image-profile-type .nova-select-option', () => {
            setTimeout(updateImageTypeRows, 0);
        });

        $(document).off('click.novaImgProfile').on('click.novaImgProfile', '#nova-image-profile-list .nova-select-option', function() {
            const cfg = getImageSettings();
            const id = String($(this).data('value') || '');
            if (!id || id === cfg.active_profile) return;
            cfg.active_profile = id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-profile-new').on('click', async () => {
            const name = await novaPrompt('Новый профиль', 'Название профиля');
            if (!name) return;
            const cfg = getImageSettings();
            const profile = {
                id: `imgprof_${Date.now()}`,
                name: name.trim(),
                apiType: 'openai',
                endpoint: '',
                apiKey: '',
                model: '',
                size: '1024x1024',
                aspect_ratio: '1:1',
                image_size: '1K',
            };
            cfg.profiles.push(profile);
            cfg.active_profile = profile.id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-profile-save').on('click', () => {
            const cfg = getImageSettings();
            const profile = getActiveImageProfile();
            if (!profile) return;
            profile.name = $('#nova-image-profile-name').val().trim() || 'Без названия';
            profile.apiType = String($('#nova-image-profile-type').attr('data-value') || 'openai');
            profile.endpoint = $('#nova-image-profile-endpoint').val().trim();
            profile.apiKey = $('#nova-image-profile-key').val().trim();
            profile.model = String($('#nova-image-profile-model').attr('data-value') || '').trim();
            profile.aspect_ratio = String($('#nova-image-profile-aspect').attr('data-value') || '1:1');
            profile.image_size = String($('#nova-image-profile-imagesize').attr('data-value') || '1K');
            cfg.active_profile = profile.id;
            saveImageSettings();
            renderImageSettings();
            toastr.success(`Профиль «${profile.name}» сохранён`, 'NOVA');
        });

        $('#nova-image-profile-delete').on('click', () => {
            const cfg = getImageSettings();
            const profile = getActiveImageProfile();
            if (!profile) return;
            novaConfirm(`Удалить профиль «${profile.name}»?`, () => {
                cfg.profiles = cfg.profiles.filter(p => p.id !== profile.id);
                cfg.active_profile = cfg.profiles[0]?.id || '';
                saveImageSettings();
                renderImageSettings();
            });
        });

        // Проверка боем: один реальный запрос дешевле, чем ловить опечатку в эндпоинте
        // посреди генерации ленты
        $('#nova-image-profile-test').on('click', async function() {
            const $btn = $(this);
            if ($btn.prop('disabled')) return;
            const profile = getActiveImageProfile();
            if (!profile) return;

            $btn.prop('disabled', true).text('Проверяю...');
            try {
                const dataUrl = await generateNovaImage(
                    'A simple test photo: a red apple on a wooden table, natural window light.',
                    profile,
                );
                openImageViewer({ image: dataUrl, prompt: 'Тестовая генерация прошла успешно' });
                toastr.success('Профиль работает', 'NOVA');
            } catch (e) {
                console.error('[NOVA] Проверка профиля картинок не прошла', e);
                toastr.error(String(e.message || e), 'NOVA', { timeOut: 12000 });
            } finally {
                $btn.prop('disabled', false).text('Проверить');
            }
        });

        $(document).off('click.novaImgPreset').on('click.novaImgPreset', '#nova-image-preset-list .nova-select-option', function() {
            const cfg = getImageSettings();
            const id = String($(this).data('value') || '');
            if (!id || id === cfg.active_preset) return;
            cfg.active_preset = id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-preset-new').on('click', async () => {
            const name = await novaPrompt('Новый промпт', 'Название промпта');
            if (!name) return;
            const cfg = getImageSettings();
            const preset = {
                id: `preset_${Date.now()}`,
                name: name.trim(),
                // Пустое поле, а не копия дефолта — иначе новый промпт выглядит уже
                // заполненным чужим текстом, и непонятно, что вообще поменялось
                prompt: '',
            };
            cfg.presets.push(preset);
            cfg.active_preset = preset.id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-preset-save').on('click', () => {
            const cfg = getImageSettings();
            const preset = getActiveImagePreset();
            if (!preset) return;
            preset.name = $('#nova-image-preset-name').val().trim() || 'Без названия';
            preset.prompt = $('#nova-image-preset-prompt').val();
            cfg.active_preset = preset.id;
            saveImageSettings();
            renderImageSettings();
            toastr.success(`Промпт «${preset.name}» сохранён`, 'NOVA');
        });

        $('#nova-image-preset-delete').on('click', () => {
            const cfg = getImageSettings();
            const preset = getActiveImagePreset();
            if (!preset) return;
            if (cfg.presets.length <= 1) {
                toastr.info('Это последний промпт — удалить его нельзя.');
                return;
            }
            novaConfirm(`Удалить промпт «${preset.name}»?`, () => {
                cfg.presets = cfg.presets.filter(p => p.id !== preset.id);
                cfg.active_preset = cfg.presets[0]?.id || '';
                saveImageSettings();
                renderImageSettings();
            });
        });

        $(document).off('click.novaImgStyle').on('click.novaImgStyle', '#nova-image-style-list .nova-select-option', function() {
            const cfg = getImageSettings();
            const id = String($(this).data('value') || '');
            if (!id || id === cfg.active_style) return;
            cfg.active_style = id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-style-new').on('click', async () => {
            const name = await novaPrompt('Новый стиль', 'Название стиля');
            if (!name) return;
            const cfg = getImageSettings();
            const style = {
                id: `style_${Date.now()}`,
                name: name.trim(),
                style: '',
                preview: '',
            };
            cfg.styles.push(style);
            cfg.active_style = style.id;
            saveImageSettings();
            renderImageSettings();
        });

        $('#nova-image-style-save').on('click', () => {
            const cfg = getImageSettings();
            const style = getActiveImageStyle();
            if (!style) return;
            style.name = $('#nova-image-style-name').val().trim() || 'Без названия';
            style.style = $('#nova-image-style-text').val().trim();
            cfg.active_style = style.id;
            saveImageSettings();
            renderImageSettings();
            toastr.success(`Стиль «${style.name}» сохранён`, 'NOVA');
        });

        $('#nova-image-style-delete').on('click', () => {
            const cfg = getImageSettings();
            const style = getActiveImageStyle();
            if (!style) return;
            if (cfg.styles.length <= 1) {
                toastr.info('Это последний стиль — удалить его нельзя.');
                return;
            }
            novaConfirm(`Удалить стиль «${style.name}»?`, () => {
                cfg.styles = cfg.styles.filter(s => s.id !== style.id);
                cfg.active_style = cfg.styles[0]?.id || '';
                saveImageSettings();
                renderImageSettings();
            });
        });

        $(document).off('click.novaImgStyleThumb').on('click.novaImgStyleThumb', '#nova-image-style-thumb', () => {
            $('#nova-image-style-file').trigger('click');
        });

        $('#nova-image-style-file').on('change', async function() {
            const file = this.files?.[0];
            this.value = '';
            if (!file) return;
            const style = getActiveImageStyle();
            if (!style) return;

            try {
                const dataUrl = await compressImageFile(file, 512, 0.85);
                const path = await uploadNovaImage(dataUrl);
                style.preview = path;
                saveImageSettings();
                renderImageSettings();
            } catch (e) {
                console.error('[NOVA] Не удалось загрузить превью стиля', e);
                toastr.error('Не удалось загрузить превью: ' + (e.message || ''));
            }
        });
    }

    function refreshConnectionProfiles() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext) return;
        
        const { extensionSettings } = stContext;
        
        let profileEntries = [];

        const cmProfiles = extensionSettings?.connectionManager?.profiles || window.extension_settings?.connectionManager?.profiles || [];
        if (Array.isArray(cmProfiles)) {
            profileEntries = cmProfiles
                .filter(p => p && p.name)
                .map(p => ({ name: p.name, id: p.id || '', supported: true }));
        }

        if (profileEntries.length === 0 && window.system_settings?.api_profiles) {
            const pObj = window.system_settings.api_profiles;
            if (Array.isArray(pObj)) {
                pObj.forEach(p => { if (p.name) profileEntries.push({ name: p.name, id: p.id || '', supported: true }); });
            } else {
                Object.keys(pObj).forEach(k => profileEntries.push({ name: k, id: '', supported: true }));
            }
        }

        const profileNames = profileEntries.map(p => p.name);

        const $select = $('#nova-proxy-list');
        if (!$select.length) return;

        $select.empty();
        $select.append($('<option>', { value: '', text: '-- Главный API --' }));
        profileEntries.forEach(entry => {
            const $option = $('<option>', {
                value: entry.name,
                text: entry.name,
            });
            $option.attr('data-profile-id', entry.id);
            $select.append($option);
        });

        if (!extensionSettings.NOVA) extensionSettings.NOVA = {};
        const saved = extensionSettings.NOVA.connection_profile || '';
        const savedId = extensionSettings.NOVA.connection_profile_id || '';
        const byId = savedId ? profileEntries.find(p => p.id === savedId) : null;

        if (byId) {
            // Профиль мог быть переименован — ориентируемся на id
            $select.val(byId.name);
            extensionSettings.NOVA.connection_profile = byId.name;
        } else if (profileNames.includes(saved)) {
            $select.val(saved);
            const entry = profileEntries.find(p => p.name === saved);
            if (entry?.id) extensionSettings.NOVA.connection_profile_id = entry.id;
        } else {
            $select.val('');
            if (saved) {
                toastr.warning(`Профиль подключения «${saved}» больше не существует — NOVA переключён на Главный API.`);
                extensionSettings.NOVA.connection_profile = '';
                extensionSettings.NOVA.connection_profile_id = '';
                stContext.saveSettingsDebounced?.();
            }
        }
        
        if (extensionSettings.NOVA.context_size) {
            $('#nova-context-size').val(extensionSettings.NOVA.context_size);
            $('#nova-context-size-val').text(extensionSettings.NOVA.context_size);
        }
        // Значения не из настроек, а через getGenSetting — иначе новый юзер увидит одно, а получит другое
        // Слайдер округляет значение до своего шага — читаем обратно, чтобы подпись не расходилась
        const maxTokensValue = String($('#nova-max-tokens').val(String(getGenSetting(stContext, 'max_tokens'))).val());
        $('#nova-max-tokens-val').text(maxTokensValue === '0' ? '0 (Авто)' : maxTokensValue);
        const feedHistoryValue = String($('#nova-feed-history-size').val(String(getGenSetting(stContext, 'feed_history_size'))).val());
        $('#nova-feed-history-size-val').text(feedHistoryValue === '0' ? 'без лимита' : feedHistoryValue);
        const dmHistoryValue = String($('#nova-dm-history-size').val(String(getGenSetting(stContext, 'dm_history_size'))).val());
        $('#nova-dm-history-size-val').text(dmHistoryValue === '0' ? 'без лимита' : dmHistoryValue);
        // Через normalize — иначе сохранённое от старых версий 'disabled' оставит селект пустым
        $('#nova-thinking-budget').val(normalizeReasoningEffort(getGenSetting(stContext, 'thinking_budget')));
        $('#nova-thinking-hint').val(getGenSetting(stContext, 'thinking_hint'));
        updateThinkingBadge();
        $('#nova-thinking-hint-enabled').prop('checked', extensionSettings.NOVA.thinking_hint_enabled !== false);
        $('#nova-start-reply-with').val(extensionSettings.NOVA.start_reply_with || '');
        $('#nova-reasoning-prefix').val(extensionSettings.NOVA.reasoning_prefix ?? NOVA_GEN_DEFAULTS.reasoning_prefix);
        $('#nova-reasoning-suffix').val(extensionSettings.NOVA.reasoning_suffix ?? NOVA_GEN_DEFAULTS.reasoning_suffix);
        $('#nova-reasoning-auto-parse').prop('checked', extensionSettings.NOVA.reasoning_auto_parse !== false);
        $('#nova-thinking-prompt').val(getGenSetting(stContext, 'thinking_prompt'));
        $('#nova-thinking-prompt-enabled').prop('checked', !!extensionSettings.NOVA.thinking_prompt_enabled);
        if (extensionSettings.NOVA.include_char_card !== undefined) {
            $('#nova-include-char-card').prop('checked', extensionSettings.NOVA.include_char_card);
        }
        if (extensionSettings.NOVA.include_persona !== undefined) {
            $('#nova-include-user-persona').prop('checked', extensionSettings.NOVA.include_persona);
        }
        if (extensionSettings.NOVA.include_lorebooks !== undefined) {
            $('#nova-include-world-info').prop('checked', extensionSettings.NOVA.include_lorebooks);
        }
        $('#nova-include-author-note').prop('checked', extensionSettings.NOVA.include_author_note !== false);
        
        console.log(`[NOVA] Loaded ${profileNames.length} connection profiles.`);
    }

    // Эталонный набор NPC папки Default — нужен для кнопки «Вернуть стандартных»
    const DEFAULT_NPCS_SEED = [
            { id: 'n1', name: 'котик щитпостер', handle: '@meow_irl', avatar: 'https://i.postimg.cc/cJ6BPnS1/faa1669c512626a8317925d204d3f92a.jpg', color: '#ff9800', desc: 'Постит абстрактные мемы, картинки с котами и экзистенциальный кризис.', style: 'всё с маленькой буквы, жиза, постирония', active: true },
            { id: 'n2', name: 'Global Updates', handle: '@breaking_now', avatar: 'https://i.postimg.cc/x8HWVZL5/3e4fbb3d4cff3808056b9a6f050c0234.jpg', color: '#e91e63', desc: 'Агрегатор новостей. Постит сухие факты о том, что происходит в мире.', style: 'Официальный тон, срочные новости, 🚨 BREAKING 🚨', active: true },
            { id: 'n3', name: 'Actually...', handle: '@logic_enjoyer', avatar: 'https://i.postimg.cc/B6bDj96Y/103224cfd2aeca0001e3e9f9c7c2e9c1.jpg', color: '#607d8b', desc: 'Reply Guy. Приходит в чужие треды только для того, чтобы доказать, что автор не прав.', style: 'Начинает с "Технически...", ссылки на статьи, полное отсутствие эмпатии.', active: true },
            { id: 'n4', name: 'Spark', handle: '@main_character', avatar: 'https://i.postimg.cc/7ZLmgcbp/70c3e7f7a1a418bf56d7c62bd546b97e.jpg', color: '#ffb300', desc: 'Синдром главного героя. Уверен, что любое событие в мире происходит из-за него или ради него.', style: 'Постоянно пишет про себя, драматизирует, "Я не могу поверить, что это случилось СО МНОЙ".', active: true },
            { id: 'n5', name: 'Альфа-Мыслитель', handle: '@based_sigma', avatar: 'https://i.postimg.cc/rmymmShL/63e874716b41b8f6cb1f6aaf97db9088.jpg', color: '#e53935', desc: 'Уверен, что женщины созданы для обслуживания мужчин. Агрессивно доказывает это в каждом треде, прикрываясь "биологией" и "природой".', style: 'Псевдонаучный сексизм, снобизм, обращается к женщинам "милочка". Часто приплетает эволюцию, обесценивает чужое мнение.', active: true },
            { id: 'n6', name: 'delusional era ✨', handle: '@brainrot_diary', avatar: 'https://i.postimg.cc/d3qSg0t4/a1f9350400f3aa252b05c7694afc108e.jpg', color: '#4caf50', desc: 'Ведет этот аккаунт исключительно ради своей гиперфиксации на Главном Герое (юзере). Пишет AU-зарисовки в телефоне и выкладывает их скриншотами. Готова отменить любого, кто криво посмотрит на её краша. Живет в выдуманных сценариях 24/7.', style: 'Эмоциональные качели. Постоянный спам буквами от переизбытка чувств (ахвхахвх), избыток плачущих и блестящих эмодзи (😭🤧✨💖). Использует фразы: «я буквально кричу», «почему он такой софт», «я не доживу до завтра».', active: true },
            { id: 'n7', name: 'nanami simp ☕', handle: '@nanami_apologist', avatar: 'https://i.postimg.cc/44q98SLd/9455e255421738e576534e9b80ae70d8.jpg', color: '#3f51b5', desc: 'Циничная лучшая подруга @brainrot_diary. В своей ленте постоянно жалуется на выгорание, симпит Нанами Кенто и регулярно напоминает подписчикам, что Годжо Сатору переоценен. Однако, как только первая девочка постит что-то про юзера, она тут же врывается в реплаи, чтобы агрессивно её поддержать.', style: 'Сухой сарказм, постирония, мемы по Магической Битве. Резко переключается на капс, когда комментирует посты подруги. Часто жалуется на усталость и отсутствие логики у других людей в ленте.', active: true }
    ];

    const defaultFolder = {
        id: 'default',
        name: 'Default',
        icon: 'fa-folder',
        active: true,
        npcs: JSON.parse(JSON.stringify(DEFAULT_NPCS_SEED)),
    };

    async function generateCharProfile(char, $el) {
        const stContext = SillyTavern.getContext();
        
            $el.find('.nova-generate-profile-btn').html('<i class="fa-solid fa-spinner nova-spinner"></i> Генерация...').prop('disabled', true);
            
            $el.data('backup', {
                name: $el.find('.npc-name').val(),
                handle: $el.find('.npc-handle').val(),
                desc: $el.find('.npc-desc').val(),
                style: $el.find('.npc-style').val(),
                custom_avatar: $el.data('custom-avatar') || null
            });

            const charDesc = [char.description, char.personality, char.scenario].filter(Boolean).join('\n');
            const prompt = NovaPrompts.generateCharProfile(char.name, charDesc);

            try {
                const data = await callAIForJson(prompt, [], d => d && d.handle && d.desc);

            $el.find('.npc-name').val(data.name || char.name);
            $el.find('.npc-handle').val(data.handle);
            $el.find('.npc-desc').val(data.desc);
            $el.find('.npc-style').val(data.style || "");

            $el.find('.nova-revert-profile-btn').show();
            toastr.success(`Профиль для ${char.name} сгенерирован! Не забудьте сохранить.`);
        } catch (e) {
            console.error("[NOVA] Char profile generation failed", e);
        } finally {
            $el.find('.nova-generate-profile-btn').html('<i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать').prop('disabled', false);
        }
    }

    function openPublicProfile(profile) {
        $('#nova-public-profile-name').text(profile.name);
        $('#nova-public-profile-name-large').text(profile.name);
        $('#nova-public-profile-handle').text(profile.handle);
        $('#nova-public-profile-bio').text(profile.desc || '');
        if (profile.avatar) {
            $('#nova-public-profile-avatar').attr('src', profile.avatar).show();
        } else {
            $('#nova-public-profile-avatar').hide();
        }

        // Шапка профиля: своя картинка либо однотонная заливка
        const $banner = $('#nova-public-profile-banner');
        if (profile.banner) {
            $banner.css({ 'background-image': `url("${profile.banner}")`, 'background-color': 'transparent' });
        } else {
            $banner.css({ 'background-image': 'none', 'background-color': profile.color || 'var(--nova-accent)' });
        }

        const userPosts = [];
        const userReplies = [];

        feedPosts.forEach((p, index) => {
            if (p.handle && p.handle.toLowerCase() === profile.handle.toLowerCase()) {
                userPosts.push({ ...p, feedIndex: index });
            }
            
            const findReplies = (replies, parentObj) => {
                if (!replies) return;
                replies.forEach(r => {
                    if (r.handle && r.handle.toLowerCase() === profile.handle.toLowerCase()) {
                        userReplies.push({ 
                            ...r, 
                            feedIndex: index,
                            parentPost: parentObj 
                        });
                    }
                    if (r.replies) findReplies(r.replies, r);
                });
            };
            if (p.replies) findReplies(p.replies, p);
        });

        $('#nova-public-profile-stats').text(`${userPosts.length} постов, ${userReplies.length} ответов`);
        
        const $feed = $('#nova-public-profile-feed');
        
        const renderItems = (items) => {
            $feed.empty();
            if (items.length === 0) {
                $feed.append('<div style="text-align:center; padding: 32px; color: var(--nova-text-muted);">Здесь пока нет записей.</div>');
                return;
            }
            items.forEach(item => {
                let parentHtml = '';
                if (item.parentPost) {
                    const parent = item.parentPost;
                    parentHtml = `
                        <div class="nova-post-parent" style="padding: 12px 16px; border-bottom: 1px solid var(--nova-border); background: rgba(0,0,0,0.15); margin-bottom: 0;">
                            <div style="font-size: 12px; color: var(--nova-text-muted); margin-bottom: 6px;"><i class="fa-solid fa-reply"></i> В ответ на ${parent.handle}</div>
                            <div style="display: flex; gap: 12px;">
                                ${parent.avatar ? `<img src="${parent.avatar}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">` : `<div style="width: 24px; height: 24px; border-radius: 50%; background-color: ${parent.color || '#333'}; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;">${(parent.name || '?').charAt(0).toUpperCase()}</div>`}
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; font-weight: 600; display: inline-block;">${parent.name}</div>
                                    <div style="font-size: 13px; margin-top: 2px; color: var(--nova-text-muted);">${formatPostText(parent.text)}</div>
                                </div>
                            </div>
                        </div>
                    `;
                }

                const html = `
                    <div class="nova-post-container nova-long-pressable" data-item-type="post" data-index="${item.feedIndex}" style="cursor: pointer; border-bottom: 1px solid var(--nova-border); transition: background 0.2s;">
                        ${parentHtml}
                        <div class="nova-post" style="border-bottom: none; border-radius: 0;">
                            ${item.avatar ? `<img src="${item.avatar}" class="nova-profile-avatar">` : `<div class="nova-profile-avatar" style="background-color: ${item.color || '#333'}; color: white; font-weight: bold; font-size: 18px;">${(item.name || '?').charAt(0).toUpperCase()}</div>`}
                            <div class="nova-post-content">
                                <div class="nova-post-header">
                                    <div class="nova-post-name">${item.name}</div>
                                    <div class="nova-post-handle">${item.handle}</div>
                                    <div class="nova-post-time">· ${describePostAge(item)}</div>
                                </div>
                                <div class="nova-post-text">${formatPostText(item.text)}</div>
                                ${renderAttachedImage({...item, type: 'post', feedIndex: item.feedIndex})}
                                ${renderMusicShare(item)}
                                <div class="nova-post-stats">
                                    <span title="Ответы"><i class="fa-regular fa-comment"></i> ${item.replies ? item.replies.length : Math.floor(Math.random() * 20)}</span>
                                    <span title="Репосты"><i class="fa-solid fa-retweet"></i> ${item.retweets || 0}</span>
                                    <span title="Лайки"><i class="fa-regular fa-heart"></i> ${item.likes || 0}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                $feed.append(html);
            });
        };
        
        $feed.off('click', '.nova-post-container').on('click', '.nova-post-container', function() {
            const idx = $(this).data('index');
            openSinglePost(idx);
        });
        
        $('#nova-view-public-profile .nova-profile-tab').off('click').on('click', function() {
            $('#nova-view-public-profile .nova-profile-tab').removeClass('active').css('color', 'var(--nova-text-muted)');
            $('#nova-view-public-profile .nova-profile-tab-indicator').hide();
            
            $(this).addClass('active').css('color', 'var(--nova-text)');
            $(this).find('.nova-profile-tab-indicator').show();
            
            const tab = $(this).data('tab');
            if (tab === 'posts') {
                renderItems(userPosts);
            } else if (tab === 'replies') {
                renderItems(userReplies);
            }
        });
        
        // Reset tabs to Posts on open
        $('#nova-view-public-profile .nova-profile-tab[data-tab="posts"]').click();
        
        $('#nova-view-public-profile').addClass('active');
    }

    $(document).on('click', '.nova-clickable-profile', function(e) {
        e.stopPropagation();
        const handle = $(this).data('handle');
        if (!handle) return;
        const profile = getActiveProfiles().find(p => p.handle && p.handle.toLowerCase() === handle.toLowerCase());
        if (profile) {
            openPublicProfile(profile);
        } else {
            toastr.info("Профиль персонажа или NPC не найден");
        }
    });


    /** Подпись персоны для выпадающего списка: своё имя, иначе — живое из Таверны/её реестра персон. */
    function personaLabel(p, stContext, isLive) {
        const personaName = stContext.name1 || 'User';
        const charProfiles = stContext.extensionSettings?.NOVA?.charProfiles || {};
        const saved = charProfiles[p.id]?.name;
        return saved || (isLive ? personaName : (p.avatarId && stContext.powerUserSettings?.personas?.[p.avatarId])) || 'Персона';
    }

    function renderCharsTab() {
        const $charList = $('#nova-chars-list');
        const $personaSlot = $('#nova-persona-card-slot');
        $charList.empty();
        $personaSlot.empty();

        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext) {
            $charList.append('<div style="color: var(--nova-text-muted); font-size: 14px; text-align: center; padding: 12px;">Ожидание загрузки чата...</div>');
            return;
        }

        const charProfiles = stContext.extensionSettings?.NOVA?.charProfiles || {};
        const { characters, groups, characterId, groupId } = stContext;
        const isGroup = !!(groupId && groups);

        const currentChars = [];
        try {
            const personaName = stContext.name1 || 'User';
            const liveAvatarId = currentPersonaAvatarId();
            const personaList = getPersonasList();
            // Гарантируем запись под ТЕКУЩЕЙ живой персоной Таверны — без этого
            // именно тут и был исходный баг: один общий профиль на всех
            if (liveAvatarId && !personaList.some(p => p.avatarId === liveAvatarId)) {
                personaList.push({ id: `persona_${Date.now()}`, avatarId: liveAvatarId });
            }
            const activeEntry = getActivePersonaEntry();
            const selectedId = activeEntry?.id || personaList[0]?.id || null;

            // Список персон — компактным выпадающим списком (как пресеты/стили),
            // а не карточкой на каждую: с большим числом персон карточки мешались бы
            $('#nova-persona-select-wrap').html(personaList.length
                ? buildCustomSelect('nova-persona-list', personaList.map(p => ({
                    value: p.id,
                    label: escapeHtml(personaLabel(p, stContext, !!p.avatarId && p.avatarId === liveAvatarId)),
                })), selectedId)
                : buildCustomSelect('nova-persona-list', [{ value: '', label: '— нет персон, создайте —' }], ''));
            $('#nova-persona-delete-btn').prop('disabled', personaList.length === 0)
                .css('opacity', personaList.length === 0 ? 0.5 : 1);

            if (!selectedId) {
                // Персона Таверны не определена вовсе — прежнее поведение как заглушка
                currentChars.push({ name: personaName, avatar: '', _memberId: null, isUser: true });
            } else {
                const p = personaList.find(x => x.id === selectedId);
                const isLive = !!p.avatarId && p.avatarId === liveAvatarId;
                currentChars.push({
                    name: isLive ? personaName : (p.avatarId && stContext.powerUserSettings?.personas?.[p.avatarId]) || 'Персона',
                    avatar: p.avatarId || '',
                    _memberId: p.id,
                    isUser: true,
                    _personaId: p.id,
                });
            }

            if (isGroup) {
                const group = groups.find(g => g.id === groupId || String(g.id) === String(groupId));
                if (group && group.members) {
                    group.members.forEach(memberId => {
                        const char = characters.find(c => c.avatar === memberId || String(c.id) === String(memberId));
                        if (char) currentChars.push({ ...char, _memberId: memberId });
                    });
                }
            } else if (characterId !== undefined && characters && characters[characterId]) {
                const char = characters[characterId];
                currentChars.push({ ...char, _memberId: char.avatar });
            }
        } catch (e) {
            console.warn("[NOVA] Failed to parse chat characters", e);
        }

        if (currentChars.length === 0) {
            $charList.append('<div style="color: var(--nova-text-muted); font-size: 14px; text-align: center; padding: 12px;">Нет активных персонажей в чате.</div>');
        } else {
            currentChars.forEach(char => {
                // Крайний случай: у Таверны вообще нет активной персоны (user_avatar
                // пуст) — тогда currentChars получил заглушку без id. Заводим персону
                // прямо тут, чтобы сохранение карточки было куда писать
                const memberId = (char.isUser && !char._memberId) ? ensureActivePersonaId() : char._memberId;
                const memberIdStr = String(memberId);
                const genProfile = charProfiles[memberId];
                
                let avatarUrl = char.avatar ? (char.isUser ? `/User Avatars/${char.avatar}` : `/characters/${char.avatar}`) : '';
                if (genProfile && genProfile.custom_avatar) {
                    avatarUrl = genProfile.custom_avatar;
                }

                const isDisabled = disabledGroupChars.has(memberIdStr);
                const handle = genProfile && genProfile.handle ? genProfile.handle : `@${(char.name || 'user').toLowerCase().replace(/[^a-z0-9а-яА-Я_]/gi, '')}`;
                const name = genProfile && genProfile.name ? genProfile.name : (char.name || 'Unknown');
                
                const html = `
                    <div class="nova-profile-card nova-char-card" data-member-id="${memberId}" style="${isDisabled ? 'opacity: 0.5;' : ''}">
                        <div class="nova-profile-header">
                            ${avatarUrl ? `<img src="${avatarUrl}" class="nova-profile-avatar" onerror="this.style.display='none'">` : `<div class="nova-profile-avatar"><i class="fa-solid fa-user"></i></div>`}
                            <div class="nova-profile-info" style="cursor:pointer;" title="Открыть публичный профиль">
                                <div class="nova-profile-name">${name}</div>
                                <div class="nova-profile-handle">${handle}</div>
                            </div>
                            
                            ${char.isUser ? '' : `
                            <label class="nova-switch nova-char-toggle-label" title="Включить/Отключить персонажа в ленте" style="margin-right: 12px;">
                                <input type="checkbox" class="nova-char-active-toggle" ${isDisabled ? '' : 'checked'}>
                                <span class="nova-slider"></span>
                            </label>
                            `}

                            <div class="nova-profile-toggle" title="Настройки профиля"><i class="fa-solid fa-gear"></i></div>
                        </div>
                        <div class="nova-profile-body">
                            <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; color: var(--nova-text-muted); margin-bottom: 4px;">Имя</div>
                                    <input type="text" class="nova-input npc-name" value="${name}">
                                </div>
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; color: var(--nova-text-muted); margin-bottom: 4px;">Юзернейм</div>
                                    <input type="text" class="nova-input npc-handle" value="${handle}">
                                </div>
                            </div>

                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 13px; color: var(--nova-text-muted); margin-bottom: 4px;">Описание (био)</div>
                                <textarea class="nova-input npc-desc" rows="2" style="resize: vertical;">${genProfile ? (genProfile.desc || '') : ''}</textarea>
                            </div>
                            
                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 13px; color: var(--nova-text-muted); margin-bottom: 4px;">Стиль постов</div>
                                <input type="text" class="nova-input npc-style" value="${genProfile ? (genProfile.style || '') : ''}">
                            </div>

                            <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 12px;">
                                <div style="position: relative; cursor: pointer;" class="nova-avatar-upload-wrapper" title="Загрузить новый аватар">
                                    <img class="nova-profile-avatar-preview" src="${avatarUrl}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">
                                    <div style="position: absolute; bottom: -4px; right: -4px; background: var(--nova-accent); color: white; border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 10px;"><i class="fa-solid fa-camera"></i></div>
                                </div>
                                <input type="file" class="nova-avatar-upload-input" accept="image/*" style="display: none;">
                                <div style="position: relative; cursor: pointer; width: 96px; height: 32px; border-radius: 8px; overflow: hidden; background: var(--nova-surface-hover); border: 1px dashed var(--nova-border); display: flex; align-items: center; justify-content: center; flex-shrink: 0;" class="nova-banner-upload-wrapper" title="Загрузить шапку профиля">
                                    <img class="nova-banner-preview" src="${genProfile && genProfile.banner ? genProfile.banner : ''}" style="width: 100%; height: 100%; object-fit: cover; ${genProfile && genProfile.banner ? '' : 'display: none;'}">
                                    <i class="fa-solid fa-image nova-banner-empty-icon" style="font-size: 12px; color: var(--nova-text-muted); ${genProfile && genProfile.banner ? 'display: none;' : ''}"></i>
                                    <button class="nova-banner-clear-btn" title="Убрать шапку" style="position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,0.6); color: white; border: none; width: 16px; height: 16px; border-radius: 50%; cursor: pointer; font-size: 9px; line-height: 1; padding: 0; ${genProfile && genProfile.banner ? '' : 'display: none;'}">
                                        <i class="fa-solid fa-xmark"></i>
                                    </button>
                                </div>
                                <input type="file" class="nova-banner-upload-input" accept="image/*" style="display: none;">
                                <div style="font-size: 12px; color: var(--nova-text-muted);">Аватарка и шапка профиля для соцсети.</div>
                            </div>

                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 13px; color: var(--nova-text-muted); margin-bottom: 4px;">Что изображено на аватарке (для НПС)</div>
                                <textarea class="nova-input npc-avatar-desc" rows="1" style="resize: vertical;">${genProfile ? (genProfile.avatar_desc || '') : ''}</textarea>
                            </div>

                            <div style="display: flex; gap: 8px;">
                                <button class="nova-generate-profile-btn" style="flex: 1; background:var(--nova-surface-hover);border:1px solid var(--nova-border);color:var(--nova-text);padding:8px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать
                                </button>
                                <button class="nova-revert-profile-btn" style="flex: 1; background:var(--nova-surface);border:1px solid var(--nova-border);color:var(--nova-text);padding:8px;border-radius:8px;cursor:pointer;font-size:13px;display:none;align-items:center;justify-content:center;gap:6px;transition:all 0.2s;">
                                    <i class="fa-solid fa-rotate-left"></i> Откатить
                                </button>
                                <button class="nova-save-profile-btn" style="flex: 1; background:var(--nova-accent);border:none;color:white;padding:8px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;transition:all 0.2s; font-weight: bold;">
                                    <i class="fa-solid fa-floppy-disk"></i> Сохранить
                                </button>
                            </div>
                        </div>
                    </div>
                `;
                const $el = $(html);

                $el.find('.nova-profile-toggle').on('click', function(e) {
                    e.stopPropagation();
                    $el.toggleClass('expanded');
                });

                $el.find('.nova-profile-info').on('click', function(e) {
                    e.stopPropagation();
                    const bannerEdit = $el.data('custom-banner');
                    const profileData = {
                        name: $el.find('.npc-name').val(),
                        handle: $el.find('.npc-handle').val(),
                        desc: $el.find('.npc-desc').val(),
                        avatar: $el.find('img.nova-profile-avatar').attr('src') || $el.find('img.nova-profile-avatar-preview').attr('src'),
                        banner: bannerEdit === undefined ? (genProfile ? genProfile.banner : null) : (bannerEdit || null),
                        memberId: memberId
                    };
                    openPublicProfile(profileData);
                });

                $el.find('.nova-profile-body').on('click', function(e) {
                    e.stopPropagation();
                });

                $el.find('.nova-char-active-toggle').on('change', function(e) {
                    const enabled = $(this).is(':checked');
                    if (enabled) {
                        disabledGroupChars.delete(memberIdStr);
                    } else {
                        disabledGroupChars.add(memberIdStr);
                    }
                    saveFolders();
                    $el.css('opacity', enabled ? '1' : '0.5');
                });

                $el.find('.nova-generate-profile-btn').on('click', () => {
                    generateCharProfile(char, $el);
                });

                $el.find('.nova-revert-profile-btn').on('click', () => {
                    const backup = $el.data('backup');
                    if (backup) {
                        $el.find('.npc-name').val(backup.name);
                        $el.find('.npc-handle').val(backup.handle);
                        $el.find('.npc-desc').val(backup.desc);
                        $el.find('.npc-style').val(backup.style);
                        if (backup.custom_avatar) {
                            $el.data('custom-avatar', backup.custom_avatar);
                            setCardAvatar($el, backup.custom_avatar);
                        } else {
                            $el.removeData('custom-avatar');
                            setCardAvatar($el, char.avatar ? (char.isUser ? `/User Avatars/${char.avatar}` : `/characters/${char.avatar}`) : '');
                        }
                        $el.find('.nova-revert-profile-btn').hide();
                        toastr.info('Изменения отменены');
                    }
                });

                $el.find('.nova-save-profile-btn').on('click', () => {
                    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
                    if (!extensionSettings.NOVA) extensionSettings.NOVA = {};
                    if (!extensionSettings.NOVA.charProfiles) extensionSettings.NOVA.charProfiles = {};
                    
                    let newHandle = $el.find('.npc-handle').val().trim();
                    if (newHandle && !newHandle.startsWith('@')) newHandle = '@' + newHandle;
                    const oldHandle = $el.find('.nova-profile-handle').text();
                    
                    // undefined — шапку не трогали, '' — намеренно убрали
                    const bannerEdit = $el.data('custom-banner');
                    const bannerValue = bannerEdit === undefined
                        ? (genProfile ? genProfile.banner || null : null)
                        : (bannerEdit || null);

                    extensionSettings.NOVA.charProfiles[memberId] = {
                        name: $el.find('.npc-name').val(),
                        handle: newHandle,
                        desc: $el.find('.npc-desc').val(),
                        style: $el.find('.npc-style').val(),
                        avatar_desc: $el.find('.npc-avatar-desc').val(),
                        custom_avatar: $el.data('custom-avatar') || (genProfile ? genProfile.custom_avatar : null),
                        banner: bannerValue
                    };
                    saveSettingsDebounced();
                    toastr.success(`Профиль ${name} сохранён!`);
                    
                    // Обновить аватар и имя в превью
                    $el.find('.nova-profile-name').text($el.find('.npc-name').val());
                    $el.find('.nova-profile-handle').text($el.find('.npc-handle').val());
                    const savedAvatar = extensionSettings.NOVA.charProfiles[memberId].custom_avatar;
                    if (savedAvatar) setCardAvatar($el, savedAvatar);
                    
                    syncProfilePosts(oldHandle, {
                        handle: newHandle,
                        name: $el.find('.npc-name').val(),
                        avatar: $el.data('custom-avatar') || (genProfile ? genProfile.custom_avatar : null) || (char.isUser && char.avatar ? `/User Avatars/${char.avatar}` : (char.avatar ? `/characters/${char.avatar}` : ''))
                    });
                    
                    $el.removeClass('expanded');
                });
                
                $el.find('.nova-avatar-upload-wrapper').on('click', () => {
                    $el.find('.nova-avatar-upload-input').click();
                });

                $el.find('.nova-banner-upload-wrapper').on('click', function(e) {
                    if ($(e.target).closest('.nova-banner-clear-btn').length) return;
                    $el.find('.nova-banner-upload-input').click();
                });

                $el.find('.nova-banner-upload-input').on('change', function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    openImageCropper(file, { aspect: 3, outWidth: 900, title: 'Выберите область для шапки' }, async (dataUrl) => {
                        // Превью сразу, путь вместо base64 — после загрузки (см. storeProfileImage)
                        $el.data('custom-banner', dataUrl);
                        $el.find('.nova-banner-preview').attr('src', dataUrl).show();
                        $el.find('.nova-banner-empty-icon').hide();
                        $el.find('.nova-banner-clear-btn').show();
                        $el.find('.nova-banner-upload-wrapper').css('border-style', 'solid');
                        toastr.info('Не забудьте сохранить профиль');
                        const stored = await storeProfileImage(dataUrl);
                        $el.data('custom-banner', stored);
                        $el.find('.nova-banner-preview').attr('src', stored);
                    });
                    $(this).val('');
                });

                $el.find('.nova-banner-clear-btn').on('click', function(e) {
                    e.stopPropagation();
                    $el.data('custom-banner', '');
                    $el.find('.nova-banner-preview').attr('src', '').hide();
                    $el.find('.nova-banner-empty-icon').show();
                    $(this).hide();
                    $el.find('.nova-banner-upload-wrapper').css('border-style', 'dashed');
                    toastr.info('Не забудьте сохранить профиль');
                });
                
                $el.find('.nova-avatar-upload-input').on('change', function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    openImageCropper(file, { aspect: 1, outWidth: 256, allowShape: true, title: 'Выберите область для аватарки' }, async (dataUrl) => {
                        // Превью сразу, путь вместо base64 — после загрузки (см. storeProfileImage)
                        $el.data('custom-avatar', dataUrl);
                        setCardAvatar($el, dataUrl);
                        toastr.info('Не забудьте сохранить профиль');
                        const stored = await storeProfileImage(dataUrl);
                        $el.data('custom-avatar', stored);
                        setCardAvatar($el, stored);
                    });
                    $(this).val('');
                });

                (char.isUser ? $personaSlot : $charList).append($el);
            });
        }
    }

    // Обновляет аватарку карточки персонажа: и превью в теле, и картинку в шапке.
    // В шапке может стоять <div> с иконкой (когда аватарки нет) — тогда меняем сам элемент.
    function setCardAvatar($el, dataUrl) {
        $el.find('.nova-profile-avatar-preview').attr('src', dataUrl).show();

        const $headerAvatar = $el.find('.nova-profile-header .nova-profile-avatar').not('.nova-profile-avatar-preview').first();
        if (!$headerAvatar.length) return;

        if ($headerAvatar.is('img')) {
            $headerAvatar.attr('src', dataUrl).show();
        } else {
            $headerAvatar.replaceWith(`<img src="${dataUrl}" class="nova-profile-avatar">`);
        }
    }

    // ---- NPC: общие хелперы ----

    function getAllFolders() {
        return [defaultFolder, ...customFolders];
    }

    function findNpcFolder(npcId) {
        return getAllFolders().find(f => f.npcs.some(n => n.id === npcId)) || null;
    }

    function fillFolderSelect($select, selectedId) {
        $select.empty();
        getAllFolders().forEach(f => {
            $select.append($('<option>', { value: f.id, text: f.name }));
        });
        if (selectedId) $select.val(selectedId);
    }

    // Переносит NPC в другую папку, сохраняя посты и настройки
    function moveNpcToFolder(npc, targetFolderId) {
        const source = findNpcFolder(npc.id);
        const target = getAllFolders().find(f => f.id === targetFolderId);
        if (!target || !source || source.id === target.id) return false;

        const idx = source.npcs.findIndex(n => n.id === npc.id);
        if (idx !== -1) source.npcs.splice(idx, 1);
        target.npcs.push(npc);
        saveFolders();
        return true;
    }

    // Копия NPC в другой папке: тот же персонаж, но независимая запись
    function copyNpcToFolder(npc, targetFolderId) {
        const target = getAllFolders().find(f => f.id === targetFolderId);
        if (!target) return false;

        const copy = JSON.parse(JSON.stringify(npc));
        copy.id = 'npc_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        target.npcs.push(copy);
        saveFolders();
        return true;
    }

    /**
     * Кадрирование изображения с фиксированным соотношением сторон.
     * Рамку можно двигать и тянуть за углы (мышь и тач), результат — data URL.
     * Размер картинки задаёт сам браузер (max-width/max-height), мы его лишь измеряем —
     * так ничего не уезжает за экран на телефоне.
     */
    function openImageCropper(file, options, onDone) {
        const aspect = options.aspect || 3;
        const outWidth = options.outWidth || 900;
        const title = options.title || 'Выберите область';
        const allowShape = !!options.allowShape;

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => buildCropper(img);
            img.onerror = () => toastr.error('Не удалось прочитать изображение');
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);

        function buildCropper(img) {
            let shape = 'square';

            const $overlay = $(`
                <div class="nova-cropper" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; height: 100dvh; z-index: 100020; background: rgba(0,0,0,0.92); display: flex; flex-direction: column; font-family: var(--nova-font); color: var(--nova-text); overscroll-behavior: contain; touch-action: none;">
                    <div style="flex: 0 0 auto; padding: 14px 16px 8px; text-align: center; font-size: 15px; font-weight: 600;">${title}</div>
                    <div class="nova-cropper-body" style="flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 8px 12px; overflow: hidden;">
                        <div class="nova-cropper-stage" style="position: relative; line-height: 0; touch-action: none; user-select: none; max-width: 100%; max-height: 100%;">
                            <img class="nova-cropper-img" src="${img.src}" style="display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; pointer-events: none;">
                            <div class="nova-cropper-box" style="position: absolute; border: 2px solid var(--nova-accent); box-shadow: 0 0 0 9999px rgba(0,0,0,0.6); cursor: move; box-sizing: border-box; display: none;">
                                <div class="nova-crop-handle" data-corner="nw" style="position: absolute; width: 24px; height: 24px; top: -12px; left: -12px; background: var(--nova-accent); border: 2px solid #fff; border-radius: 50%; cursor: nwse-resize; touch-action: none;"></div>
                                <div class="nova-crop-handle" data-corner="ne" style="position: absolute; width: 24px; height: 24px; top: -12px; right: -12px; background: var(--nova-accent); border: 2px solid #fff; border-radius: 50%; cursor: nesw-resize; touch-action: none;"></div>
                                <div class="nova-crop-handle" data-corner="sw" style="position: absolute; width: 24px; height: 24px; bottom: -12px; left: -12px; background: var(--nova-accent); border: 2px solid #fff; border-radius: 50%; cursor: nesw-resize; touch-action: none;"></div>
                                <div class="nova-crop-handle" data-corner="se" style="position: absolute; width: 24px; height: 24px; bottom: -12px; right: -12px; background: var(--nova-accent); border: 2px solid #fff; border-radius: 50%; cursor: nwse-resize; touch-action: none;"></div>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 auto; background: var(--nova-surface); border-top: 1px solid var(--nova-border); padding: 12px 16px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; gap: 10px;">
                        ${allowShape ? `
                        <div style="display: flex; gap: 8px; justify-content: center;">
                            <button class="nova-crop-shape" data-shape="square" style="flex: 1; max-width: 160px; background: var(--nova-accent); color: white; border: 1px solid var(--nova-accent); padding: 8px; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                <i class="fa-regular fa-square"></i> Квадрат
                            </button>
                            <button class="nova-crop-shape" data-shape="circle" style="flex: 1; max-width: 160px; background: var(--nova-surface-hover); color: var(--nova-text); border: 1px solid var(--nova-border); padding: 8px; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;">
                                <i class="fa-regular fa-circle"></i> Кружок
                            </button>
                        </div>` : ''}
                        <div style="font-size: 12px; color: var(--nova-text-muted); text-align: center;">Двигайте рамку и тяните за углы</div>
                        <div style="display: flex; gap: 12px;">
                            <button class="nova-cropper-cancel" style="flex: 1; background: var(--nova-surface-hover); color: var(--nova-text); border: 1px solid var(--nova-border); padding: 12px; border-radius: 12px; cursor: pointer; font-weight: 600;">Отмена</button>
                            <button class="nova-cropper-apply" style="flex: 1; background: var(--nova-accent); color: white; border: none; padding: 12px; border-radius: 12px; cursor: pointer; font-weight: 700;">Готово</button>
                        </div>
                    </div>
                </div>
            `);
            // Append to #nova-backdrop to stay within the same stacking context on mobile
            const $container = $('#nova-backdrop');
            if ($container.length) {
                $container.append($overlay);
            } else {
                $('body').append($overlay);
            }
            // Block background scroll while cropper is open
            $('body').addClass('nova-cropper-open');

            const $stage = $overlay.find('.nova-cropper-stage');
            const $imgEl = $overlay.find('.nova-cropper-img');
            const $box = $overlay.find('.nova-cropper-box');

            const MIN = 40;
            let dispW = 0, dispH = 0;
            let box = { x: 0, y: 0, w: 0, h: 0 };

            function applyBox() {
                $box.css({ left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
            }

            function resetBox() {
                box.w = dispW;
                box.h = dispW / aspect;
                if (box.h > dispH) {
                    box.h = dispH;
                    box.w = dispH * aspect;
                }
                box.x = (dispW - box.w) / 2;
                box.y = (dispH - box.h) / 2;
            }

            // Если браузер не дал размеров (скрытый контейнер, нулевой вьюпорт) — считаем сами
            function fallbackSize() {
                const viewW = window.innerWidth || document.documentElement.clientWidth || 360;
                const viewH = window.innerHeight || document.documentElement.clientHeight || 640;
                const maxW = Math.max(240, Math.min(viewW - 32, 820));
                const maxH = Math.max(160, viewH * 0.5);
                const natW = img.naturalWidth || 1;
                const natH = img.naturalHeight || 1;
                const ratio = Math.min(maxW / natW, maxH / natH, 1);
                const w = Math.max(1, Math.round(natW * ratio));
                const h = Math.max(1, Math.round(natH * ratio));
                $imgEl.css({ width: w + 'px', height: h + 'px' });
                return { w, h };
            }

            // Размер картинки считает браузер — мы просто измеряем результат
            function measure(keepSelection) {
                // Снимаем свои размеры, чтобы дать CSS посчитать заново
                $imgEl.css({ width: '', height: '' });
                const rect = $imgEl[0].getBoundingClientRect();
                let newW = rect.width || $imgEl[0].clientWidth;
                let newH = rect.height || $imgEl[0].clientHeight;
                if (!newW || !newH) {
                    const fb = fallbackSize();
                    newW = fb.w;
                    newH = fb.h;
                }
                if (!newW || !newH) return false;

                const scale = dispW ? newW / dispW : 0;
                dispW = newW;
                dispH = newH;
                $stage.css({ width: dispW + 'px', height: dispH + 'px' });

                if (keepSelection && scale) {
                    box.x *= scale; box.y *= scale; box.w *= scale; box.h *= scale;
                } else {
                    resetBox();
                }
                applyBox();
                $box.show();
                return true;
            }

            // Сразу — чтобы рамка была даже без раскладки (вкладка в фоне: rAF не вызывается),
            // затем уточняем, когда браузер посчитает реальные размеры
            measure(false);
            requestAnimationFrame(() => measure(true));
            setTimeout(() => measure(true), 150);

            const onResize = () => measure(true);
            $(window).on('resize.novaCropper orientationchange.novaCropper', onResize);

            function pointerPos(e) {
                const rect = $stage[0].getBoundingClientRect();
                const src = e.touches ? e.touches[0] : e;
                return { x: src.clientX - rect.left, y: src.clientY - rect.top };
            }

            let drag = null;

            $box.on('pointerdown', function(e) {
                if ($(e.target).hasClass('nova-crop-handle')) return;
                e.preventDefault();
                const p = pointerPos(e);
                drag = { type: 'move', dx: p.x - box.x, dy: p.y - box.y };
                $stage[0].setPointerCapture?.(e.pointerId);
            });

            $box.find('.nova-crop-handle').on('pointerdown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                drag = { type: 'resize', corner: $(this).data('corner') };
                $stage[0].setPointerCapture?.(e.pointerId);
            });

            $stage.on('pointermove', function(e) {
                if (!drag) return;
                e.preventDefault();
                const p = pointerPos(e);

                if (drag.type === 'move') {
                    box.x = Math.max(0, Math.min(p.x - drag.dx, dispW - box.w));
                    box.y = Math.max(0, Math.min(p.y - drag.dy, dispH - box.h));
                } else {
                    // Противоположный угол остаётся на месте
                    const anchorX = drag.corner.includes('w') ? box.x + box.w : box.x;
                    const anchorY = drag.corner.includes('n') ? box.y + box.h : box.y;
                    const goingLeft = drag.corner.includes('w');
                    const goingUp = drag.corner.includes('n');

                    let w = goingLeft ? anchorX - p.x : p.x - anchorX;
                    w = Math.max(MIN, w);
                    w = Math.min(w, goingLeft ? anchorX : dispW - anchorX);
                    let h = w / aspect;
                    const limitH = goingUp ? anchorY : dispH - anchorY;
                    if (h > limitH) {
                        h = limitH;
                        w = h * aspect;
                    }
                    box.w = w;
                    box.h = h;
                    box.x = goingLeft ? anchorX - w : anchorX;
                    box.y = goingUp ? anchorY - h : anchorY;
                }
                applyBox();
            });

            $stage.on('pointerup pointercancel', () => { drag = null; });

            $overlay.find('.nova-crop-shape').on('click', function() {
                shape = $(this).data('shape');
                $overlay.find('.nova-crop-shape').each(function() {
                    const active = $(this).data('shape') === shape;
                    $(this).css({
                        background: active ? 'var(--nova-accent)' : 'var(--nova-surface-hover)',
                        color: active ? '#fff' : 'var(--nova-text)',
                        'border-color': active ? 'var(--nova-accent)' : 'var(--nova-border)',
                    });
                });
                $box.css('border-radius', shape === 'circle' ? '50%' : '0');
            });

            function close() {
                $overlay.remove();
                $(document).off('keydown.novaCropper');
                $(window).off('.novaCropper');
                $('body').removeClass('nova-cropper-open');
            }

            $overlay.find('.nova-cropper-cancel').on('click', close);
            $(document).on('keydown.novaCropper', (e) => { if (e.key === 'Escape') close(); });

            $overlay.find('.nova-cropper-apply').on('click', () => {
                if (!dispW || !dispH) { close(); return; }
                const scale = img.naturalWidth / dispW;
                const canvas = document.createElement('canvas');
                canvas.width = outWidth;
                canvas.height = Math.round(outWidth / aspect);
                const ctx2d = canvas.getContext('2d');
                ctx2d.drawImage(
                    img,
                    box.x * scale, box.y * scale, box.w * scale, box.h * scale,
                    0, 0, canvas.width, canvas.height,
                );

                let dataUrl;
                if (shape === 'circle') {
                    // Круглая маска — прозрачные углы, поэтому PNG
                    ctx2d.globalCompositeOperation = 'destination-in';
                    ctx2d.beginPath();
                    ctx2d.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2, 0, Math.PI * 2);
                    ctx2d.fill();
                    dataUrl = canvas.toDataURL('image/png');
                } else {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                }
                close();
                onDone(dataUrl);
            });
        }
    }

    // Единый редактор: npc === null → создание, иначе редактирование
    let npcEditorState = { npc: null, folderId: 'default', avatar: null, banner: null };

    function openNpcEditor(npc, folderId) {
        const isEdit = !!npc;
        const sourceFolder = isEdit ? findNpcFolder(npc.id) : null;
        npcEditorState = {
            npc: npc,
            folderId: sourceFolder?.id || folderId || 'default',
            avatar: isEdit ? (npc.avatar || null) : null,
            banner: isEdit ? (npc.banner || null) : null,
        };

        $('#nova-npc-editor-title').text(isEdit ? 'Редактировать НПС' : 'Создать НПС');
        $('#nova-save-manual-npc-text').text(isEdit ? 'Сохранить' : 'Создать');
        $('#nova-delete-npc-btn').css('display', isEdit ? 'flex' : 'none');

        fillFolderSelect($('#nova-create-npc-folder-select'), npcEditorState.folderId);
        $('#nova-create-npc-name').val(isEdit ? npc.name : '');
        $('#nova-create-npc-handle').val(isEdit ? npc.handle : '');
        $('#nova-create-npc-desc').val(isEdit ? (npc.desc || '') : '');
        $('#nova-create-npc-style').val(isEdit ? (npc.style || '') : '');
        $('#nova-create-npc-color').val(isEdit ? (npc.color || '#607d8b') : '#607d8b');
        $('#nova-create-npc-active').prop('checked', isEdit ? npc.active !== false : true);
        $('#nova-create-npc-avatar-input').val('');

        renderNpcEditorAvatar();
        renderNpcEditorBanner();
        $('#nova-view-create-npc').addClass('active');
    }

    function renderNpcEditorBanner() {
        const banner = npcEditorState.banner;
        $('#nova-create-npc-banner-preview').attr('src', banner || '').toggle(!!banner);
        $('#nova-create-npc-banner-empty').toggle(!banner);
        $('#nova-create-npc-banner-clear').toggle(!!banner);
        $('#nova-create-npc-banner-wrapper').css('border-style', banner ? 'solid' : 'dashed');
    }

    function renderNpcEditorAvatar() {
        const avatar = npcEditorState.avatar;
        const $preview = $('#nova-create-npc-avatar-preview');
        const $placeholder = $('#nova-create-npc-avatar-placeholder');
        const name = $('#nova-create-npc-name').val() || '?';

        if (avatar) {
            $preview.attr('src', avatar).show();
            $placeholder.hide();
        } else {
            $preview.hide().attr('src', '');
            $placeholder
                .css({ display: 'flex', 'background-color': $('#nova-create-npc-color').val() || '#607d8b' })
                .text(String(name).charAt(0).toUpperCase());
        }
    }

    function saveNpcFromEditor() {
        const name = $('#nova-create-npc-name').val().trim();
        let handle = $('#nova-create-npc-handle').val().trim();
        if (!name || !handle) {
            toastr.error('Имя и юзернейм обязательны');
            return;
        }
        if (!handle.startsWith('@')) handle = '@' + handle;

        const targetFolderId = $('#nova-create-npc-folder-select').val();
        const targetFolder = getAllFolders().find(f => f.id === targetFolderId);
        if (!targetFolder) {
            toastr.error('Папка не найдена');
            return;
        }

        const fields = {
            name: name,
            handle: handle,
            avatar: npcEditorState.avatar || null,
            banner: npcEditorState.banner || null,
            color: $('#nova-create-npc-color').val() || '#607d8b',
            desc: $('#nova-create-npc-desc').val(),
            style: $('#nova-create-npc-style').val(),
            active: $('#nova-create-npc-active').is(':checked'),
        };

        if (npcEditorState.npc) {
            const npc = npcEditorState.npc;
            const oldHandle = npc.handle;
            Object.assign(npc, fields);

            const currentFolder = findNpcFolder(npc.id);
            if (currentFolder && currentFolder.id !== targetFolderId) {
                moveNpcToFolder(npc, targetFolderId);
                toastr.success(`«${npc.name}» перемещён в «${targetFolder.name}»`);
            } else {
                toastr.success('Изменения сохранены');
            }
            saveFolders();
            // Подтягиваем новое имя/аватар в уже опубликованные посты
            syncProfilePosts(oldHandle, npc);
        } else {
            targetFolder.npcs.push({ id: 'npc_' + Date.now(), ...fields });
            saveFolders();
            toastr.success('НПС создан!');
        }

        $('#nova-view-create-npc').removeClass('active');
        renderProfilesTab();
        if ($('#nova-view-folder-overlay').hasClass('active')) {
            const openFolder = getAllFolders().find(f => f.id === (currentOpenFolderId || 'default'));
            if (openFolder) openFolderOverlay(openFolder);
        }
    }

    async function deleteNpc(npc, onDone) {
        const result = await Popup.show.confirm('Удалить NPC?', `Вы точно хотите удалить "${npc.name}"?`);
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        const folder = findNpcFolder(npc.id);
        if (folder) {
            const idx = folder.npcs.findIndex(n => n.id === npc.id);
            if (idx !== -1) folder.npcs.splice(idx, 1);
            saveFolders();
        }
        toastr.success(`NPC "${npc.name}" удалён`);
        if (onDone) onDone();
    }

    function renderProfilesTab() {
        const $foldersGrid = $('#nova-folders-grid');
        const $archiveGrid = $('#nova-archive-folders-grid');
        
        $foldersGrid.empty();
        if ($archiveGrid.length) $archiveGrid.empty();

        const stContext = SillyTavern.getContext();
        const currentChatId = stContext ? stContext.chatId : null;

        const allFolders = [defaultFolder, ...customFolders];
        
        allFolders.forEach(folder => {
            const isArchive = Array.isArray(folder.chatIds) && currentChatId && !folder.chatIds.includes(currentChatId);
            
            const checkedAttr = folder.active ? 'checked' : '';
            const isCustom = folder.id !== 'default';
            
            const html = `
                <div class="nova-folder-card" data-folder-id="${folder.id}">
                    ${isArchive ? `
                    <button class="nova-folder-unarchive-btn" title="Добавить в этот чат" style="position:absolute;bottom:8px;left:8px;background:var(--nova-accent);border:none;color:white;width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;transition:all 0.2s;z-index:5;">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    ` : `
                    <label class="nova-folder-external-toggle" title="Вкл/Выкл папку">
                        <input type="checkbox" class="folder-master-toggle-outside" ${checkedAttr} style="accent-color: var(--nova-accent); width: 16px; height: 16px; margin: 0; cursor: pointer;">
                    </label>`}
                    ${isCustom && !isArchive ? `
                    <button class="nova-folder-move-archive-btn" title="В архив" style="position:absolute;bottom:8px;left:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:var(--nova-text-muted);width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;transition:all 0.2s;z-index:5;">
                        <i class="fa-solid fa-box-archive"></i>
                    </button>` : ''}
                    ${isCustom ? `
                    <button class="nova-folder-delete-btn" title="Удалить папку" style="position:absolute;bottom:8px;right:8px;background:rgba(244,67,54,0.15);border:1px solid rgba(244,67,54,0.4);color:#f44336;width:24px;height:24px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;transition:all 0.2s;z-index:5;">
                        <i class="fa-solid fa-trash"></i>
                    </button>` : ''}
                    <i class="fa-solid ${folder.icon} nova-folder-icon"></i>
                    <div class="nova-folder-name">${folder.name}</div>
                    <div class="nova-folder-count">${folder.npcs.length} NPC</div>
                </div>
            `;
            const $el = $(html);
            
            if (isArchive) {
                $el.find('.nova-folder-unarchive-btn').on('click', (e) => {
                    e.stopPropagation();
                    // Добавляем этот чат к списку — папка остаётся активной и во всех,
                    // где уже была, а не переезжает сюда одна
                    if (!Array.isArray(folder.chatIds)) folder.chatIds = [];
                    if (!folder.chatIds.includes(currentChatId)) folder.chatIds.push(currentChatId);
                    saveFolders();
                    toastr.success(`Папка "${folder.name}" добавлена в этот чат`);
                    renderProfilesTab();
                });
            } else {
                $el.find('.folder-master-toggle-outside').on('click', (e) => {
                    e.stopPropagation();
                    folder.active = e.target.checked;
                    saveFolders();
                });
            }

            // Удаление кастомной папки
            if (isCustom) {
                $el.find('.nova-folder-delete-btn').on('click', async (e) => {
                    e.stopPropagation();
                    const result = await Popup.show.confirm('Удалить папку?', `Вы точно хотите удалить "${folder.name}"? Все её NPC будут удалены.`);
                    if (result === POPUP_RESULT.AFFIRMATIVE) {
                        const idx = customFolders.findIndex(f => f.id === folder.id);
                        if (idx !== -1) customFolders.splice(idx, 1);
                        saveFolders();
                        toastr.success(`Папка "${folder.name}" удалена`);
                        renderProfilesTab();
                    }
                });
            }

            if (isCustom && !isArchive) {
                $el.find('.nova-folder-move-archive-btn').on('click', (e) => {
                    e.stopPropagation();
                    // Убираем только текущий чат из списка — в остальных, где папка
                    // была активна, она активной и остаётся
                    folder.chatIds = (Array.isArray(folder.chatIds) ? folder.chatIds : [])
                        .filter(id => id !== currentChatId);
                    saveFolders();
                    toastr.success(`Папка "${folder.name}" перемещена в Архив`);
                    renderProfilesTab();
                });
            }

            $el.on('click', () => openFolderOverlay(folder));
            
            if (isArchive && $archiveGrid.length) {
                $archiveGrid.append($el);
            } else {
                $foldersGrid.append($el);
            }
        });
    }

    let currentOpenFolderId = null;
    let npcSelectMode = false;
    const selectedNpcIds = new Set();

    function refreshBulkBar(folder) {
        const $bar = $('#nova-folder-bulk-bar');
        if (!npcSelectMode) {
            $bar.hide();
            return;
        }
        $bar.css('display', 'flex');
        $('#nova-folder-bulk-count').text(`Выбрано: ${selectedNpcIds.size}`);

        const $select = $('#nova-folder-bulk-move-select');
        $select.empty();
        getAllFolders()
            .filter(f => f.id !== folder.id)
            .forEach(f => $select.append($('<option>', { value: f.id, text: `→ ${f.name}` })));
        if ($select.children().length === 0) {
            $select.append($('<option>', { value: '', text: 'Нет других папок' }));
        }
    }

    function openFolderOverlay(folder) {
        closeNpcActionsMenu();
        currentOpenFolderId = folder.id;
        $('#nova-folder-title').text(folder.name);

        // Папку Default не переименовываем: её имя — опора для «Вернуть стандартных»
        const isDefaultFolder = folder.id === 'default';
        $('#nova-folder-rename-btn').toggle(!isDefaultFolder).off('click').on('click', async () => {
            const name = await novaPrompt('Название папки', 'Как назвать эту папку?');
            if (name === null) return;
            const trimmed = String(name).trim();
            if (!trimmed) {
                toastr.warning('Название не может быть пустым.');
                return;
            }
            folder.name = trimmed;
            saveFolders();
            $('#nova-folder-title').text(trimmed);
            renderProfilesTab();
            toastr.success('Папка переименована');
        });

        const $masterToggle = $('#nova-folder-master-toggle');
        $masterToggle.prop('checked', folder.active);
        $masterToggle.off('change').on('change', function() {
            folder.active = $(this).is(':checked');
            saveFolders();
            renderProfilesTab();
        });

        // Создать NPC сразу в этой папке
        $('#nova-folder-add-npc-btn').off('click').on('click', () => openNpcEditor(null, folder.id));

        // Режим множественного выбора
        $('#nova-folder-select-mode-btn').off('click').on('click', () => {
            npcSelectMode = !npcSelectMode;
            selectedNpcIds.clear();
            openFolderOverlay(folder);
        });
        $('#nova-folder-select-mode-btn').css('background', npcSelectMode ? 'var(--nova-accent)' : 'var(--nova-surface-hover)');

        $('#nova-folder-bulk-move-btn').off('click').on('click', () => {
            const targetId = $('#nova-folder-bulk-move-select').val();
            if (!targetId || selectedNpcIds.size === 0) return;
            const target = getAllFolders().find(f => f.id === targetId);
            const moving = folder.npcs.filter(n => selectedNpcIds.has(n.id));
            moving.forEach(n => moveNpcToFolder(n, targetId));
            toastr.success(`Перемещено в «${target.name}»: ${moving.length}`);
            selectedNpcIds.clear();
            npcSelectMode = false;
            renderProfilesTab();
            openFolderOverlay(folder);
        });

        $('#nova-folder-bulk-copy-btn').off('click').on('click', () => {
            const targetId = $('#nova-folder-bulk-move-select').val();
            if (!targetId || selectedNpcIds.size === 0) return;
            const target = getAllFolders().find(f => f.id === targetId);
            const copying = folder.npcs.filter(n => selectedNpcIds.has(n.id));
            copying.forEach(n => copyNpcToFolder(n, targetId));
            toastr.success(`Скопировано в «${target.name}»: ${copying.length}`);
            selectedNpcIds.clear();
            npcSelectMode = false;
            renderProfilesTab();
            openFolderOverlay(folder);
        });

        $('#nova-folder-bulk-delete-btn').off('click').on('click', async () => {
            if (selectedNpcIds.size === 0) return;
            const result = await Popup.show.confirm('Удалить выбранных?', `Будет удалено NPC: ${selectedNpcIds.size}`);
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
            folder.npcs = folder.npcs.filter(n => !selectedNpcIds.has(n.id));
            if (folder.id === 'default') defaultFolder.npcs = folder.npcs;
            saveFolders();
            selectedNpcIds.clear();
            npcSelectMode = false;
            renderProfilesTab();
            openFolderOverlay(folder);
        });

        refreshBulkBar(folder);

        // Кнопка восстановления стандартных NPC — только в папке Default
        const $restoreBtn = $('#nova-folder-restore-defaults-btn');
        if (folder.id === 'default') {
            const missing = DEFAULT_NPCS_SEED.filter(seed => !folder.npcs.some(n => n.id === seed.id));
            if (missing.length > 0) {
                $restoreBtn.css('display', 'block').off('click').on('click', () => {
                    missing.forEach(seed => folder.npcs.push(JSON.parse(JSON.stringify(seed))));
                    saveFolders();
                    toastr.success(`Возвращено NPC: ${missing.length}`);
                    renderProfilesTab();
                    openFolderOverlay(folder);
                });
            } else {
                $restoreBtn.hide();
            }
        } else {
            $restoreBtn.hide();
        }

        const $list = $('#nova-folder-npcs-list');
        $list.empty();

        folder.npcs.forEach(npc => {
            const initial = (npc.name || '?').charAt(0).toUpperCase();
            const avatarHtml = npc.avatar
                ? `<img src="${npc.avatar}" class="nova-profile-avatar" style="width:44px;height:44px;min-width:44px;" onerror="this.style.display='none'">`
                : `<div class="nova-profile-avatar" style="width:44px;height:44px;min-width:44px;background-color: ${npc.color || '#607d8b'}; color: white; font-weight: bold; font-size: 18px;">${initial}</div>`;

            const otherFolders = getAllFolders().filter(f => f.id !== folder.id);

            const $el = $(`
                <div class="nova-profile-card" data-npc="${npc.id}" style="padding: 12px; position: relative;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        ${npcSelectMode ? `<input type="checkbox" class="nova-npc-select" ${selectedNpcIds.has(npc.id) ? 'checked' : ''} style="width:18px;height:18px;accent-color: var(--nova-accent); cursor: pointer; flex-shrink: 0;">` : ''}
                        ${avatarHtml}
                        <div style="flex: 1; min-width: 0;">
                            <div class="nova-profile-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${npc.name}</div>
                            <div class="nova-profile-handle" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${npc.handle}</div>
                        </div>
                        <label class="nova-switch" title="Включить NPC в ленте" style="margin: 0; flex-shrink: 0;">
                            <input type="checkbox" class="npc-toggle-active" ${npc.active ? 'checked' : ''}>
                            <span class="nova-slider"></span>
                        </label>
                        <button class="nova-npc-menu-btn" title="Действия" style="background: transparent; border: none; color: var(--nova-text-muted); cursor: pointer; padding: 6px 4px; font-size: 16px; flex-shrink: 0;">
                            <i class="fa-solid fa-ellipsis-vertical"></i>
                        </button>
                    </div>
                </div>
            `);

            // Тап по карточке: в режиме выбора — отметить, иначе — открыть редактор
            $el.on('click', function(e) {
                if ($(e.target).closest('.nova-switch, .nova-npc-menu-btn, .nova-npc-menu, .nova-npc-select').length) return;
                if (npcSelectMode) {
                    $el.find('.nova-npc-select').prop('checked', !$el.find('.nova-npc-select').prop('checked')).trigger('change');
                    return;
                }
                openNpcEditor(npc, folder.id);
            });

            $el.find('.nova-npc-select').on('change', function() {
                if ($(this).is(':checked')) selectedNpcIds.add(npc.id);
                else selectedNpcIds.delete(npc.id);
                refreshBulkBar(folder);
            });

            $el.find('.npc-toggle-active').on('change', function() {
                npc.active = $(this).is(':checked');
                saveFolders();
            });

            $el.find('.nova-npc-menu-btn').on('click', function(e) {
                e.stopPropagation();
                openNpcActionsMenu(npc, folder, this, otherFolders);
            });

            $list.append($el);
        });

        if (folder.npcs.length === 0) {
            $list.append(`
                <div style="color: var(--nova-text-muted); text-align: center; padding: 32px 16px;">
                    <div style="margin-bottom: 12px;">Папка пуста</div>
                    <button class="nova-folder-empty-add" style="background: var(--nova-accent); color: white; border: none; padding: 10px 18px; border-radius: 12px; font-weight: 600; cursor: pointer;">
                        <i class="fa-solid fa-user-plus"></i> Создать NPC
                    </button>
                </div>
            `);
            $list.find('.nova-folder-empty-add').on('click', () => openNpcEditor(null, folder.id));
        }

        $('#nova-view-folder-overlay').addClass('active');
    }

    function closeNpcActionsMenu() {
        $('.nova-npc-menu').remove();
        $(document).off('.novaNpcMenu');
        $(window).off('.novaNpcMenu');
        $('#nova-view-folder-overlay, #nova-view-folder-overlay .nova-content').off('.novaNpcMenu');
    }

    /**
     * Меню действий NPC. Рендерится в <body> с position: fixed —
     * у карточки стоит overflow: hidden, внутри неё выпадашку обрезает.
     */
    /**
     * Меню действий NPC. Рендерится в <body> с position: fixed —
     * у карточки стоит overflow: hidden, внутри неё выпадашку обрезает.
     * Двухшаговое: сначала действие, потом выбор папки (иначе при десятке папок список нечитаем).
     */
    function openNpcActionsMenu(npc, folder, buttonEl, otherFolders) {
        const alreadyOpen = $('.nova-npc-menu').data('npc-id') === npc.id;
        closeNpcActionsMenu();
        if (alreadyOpen) return;

        const itemStyle = 'padding: 10px 14px; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 10px;';
        const SEARCH_THRESHOLD = 7;

        const $menu = $(`<div class="nova-npc-menu" style="position: fixed; background: var(--nova-surface); border: 1px solid var(--nova-border); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 100010; min-width: 220px; max-width: min(320px, 90vw); font-family: var(--nova-font); color: var(--nova-text); overflow: hidden;"></div>`);
        $menu.data('npc-id', npc.id);
        $('body').append($menu);

        function positionMenu() {
            const rect = buttonEl.getBoundingClientRect();
            const menuW = $menu.outerWidth();
            const menuH = $menu.outerHeight();
            const margin = 8;

            let left = rect.right - menuW;
            left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));

            let top = rect.bottom + 4;
            if (top + menuH > window.innerHeight - margin) {
                const above = rect.top - menuH - 4;
                top = above >= margin ? above : Math.max(margin, window.innerHeight - menuH - margin);
            }
            $menu.css({ left: left + 'px', top: top + 'px' });
        }

        function renderRoot() {
            $menu.html(`
                <div style="padding: 4px 0;">
                    <div class="nova-npc-menu-item" data-action="edit" style="${itemStyle}">
                        <i class="fa-solid fa-pen" style="width: 16px;"></i> Редактировать
                    </div>
                    ${otherFolders.length ? `
                    <div class="nova-npc-menu-item" data-action="submenu" data-mode="move" style="${itemStyle}">
                        <i class="fa-solid fa-right-left" style="width: 16px;"></i>
                        <span style="flex: 1;">Переместить в…</span>
                        <i class="fa-solid fa-chevron-right" style="font-size: 11px; color: var(--nova-text-muted);"></i>
                    </div>
                    <div class="nova-npc-menu-item" data-action="submenu" data-mode="copy" style="${itemStyle}">
                        <i class="fa-regular fa-copy" style="width: 16px;"></i>
                        <span style="flex: 1;">Копировать в…</span>
                        <i class="fa-solid fa-chevron-right" style="font-size: 11px; color: var(--nova-text-muted);"></i>
                    </div>` : `
                    <div style="padding: 10px 14px; font-size: 12px; color: var(--nova-text-muted);">Других папок пока нет</div>`}
                    <div class="nova-npc-menu-item" data-action="delete" style="${itemStyle} color: #f44336; border-top: 1px solid var(--nova-border); margin-top: 4px;">
                        <i class="fa-solid fa-trash" style="width: 16px;"></i> Удалить
                    </div>
                </div>
            `);
            positionMenu();
        }

        function renderFolderPicker(mode) {
            const isMove = mode === 'move';
            const showSearch = otherFolders.length >= SEARCH_THRESHOLD;

            $menu.html(`
                <div class="nova-npc-submenu-header" style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--nova-border); background: var(--nova-surface-hover);">
                    <i class="fa-solid fa-arrow-left nova-npc-menu-back" style="cursor: pointer; padding: 2px 4px; color: var(--nova-text-muted);"></i>
                    <span style="font-size: 13px; font-weight: 600;">${isMove ? 'Переместить в' : 'Копировать в'}</span>
                </div>
                ${showSearch ? `
                <div style="padding: 8px 10px; border-bottom: 1px solid var(--nova-border);">
                    <input type="text" class="nova-npc-folder-search" placeholder="Поиск папки…" style="width: 100%; background: var(--nova-bg); border: 1px solid var(--nova-border); color: var(--nova-text); padding: 6px 10px; border-radius: 8px; font-size: 13px; outline: none; font-family: var(--nova-font);">
                </div>` : ''}
                <div class="nova-npc-folder-list" style="max-height: min(320px, 50vh); overflow-y: auto; padding: 4px 0;">
                    ${otherFolders.map(f => `
                    <div class="nova-npc-menu-item" data-action="${mode}" data-folder="${f.id}" data-name="${String(f.name).toLowerCase()}" style="${itemStyle}">
                        <i class="fa-solid ${f.icon || 'fa-folder'}" style="width: 16px; color: var(--nova-text-muted);"></i>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${f.name}</span>
                    </div>`).join('')}
                    <div class="nova-npc-folder-empty" style="display: none; padding: 12px 14px; font-size: 13px; color: var(--nova-text-muted);">Ничего не найдено</div>
                </div>
            `);
            positionMenu();
            if (showSearch) $menu.find('.nova-npc-folder-search').trigger('focus');
        }

        // Обработчики делегированы — содержимое меню перерисовывается
        $menu.on('mouseenter', '.nova-npc-menu-item', function() {
            $(this).css('background', 'var(--nova-surface-hover)');
        }).on('mouseleave', '.nova-npc-menu-item', function() {
            $(this).css('background', 'transparent');
        });

        $menu.on('click', '.nova-npc-menu-back', function(e) {
            e.stopPropagation();
            renderRoot();
        });

        $menu.on('input', '.nova-npc-folder-search', function() {
            const q = String($(this).val()).trim().toLowerCase();
            let visible = 0;
            $menu.find('.nova-npc-folder-list .nova-npc-menu-item').each(function() {
                const match = !q || String($(this).data('name')).includes(q);
                $(this).toggle(match);
                if (match) visible++;
            });
            $menu.find('.nova-npc-folder-empty').toggle(visible === 0);
            positionMenu();
        });

        $menu.on('click', '.nova-npc-menu-item', async function(e) {
            e.stopPropagation();
            const action = $(this).data('action');

            if (action === 'submenu') {
                renderFolderPicker(String($(this).data('mode')));
                return;
            }

            const targetId = $(this).data('folder') !== undefined ? String($(this).data('folder')) : null;
            closeNpcActionsMenu();

            if (action === 'edit') {
                openNpcEditor(npc, folder.id);
            } else if (action === 'move') {
                const target = getAllFolders().find(f => f.id === targetId);
                if (moveNpcToFolder(npc, targetId)) {
                    toastr.success(`«${npc.name}» → «${target.name}»`);
                    renderProfilesTab();
                    openFolderOverlay(folder);
                }
            } else if (action === 'copy') {
                const target = getAllFolders().find(f => f.id === targetId);
                if (copyNpcToFolder(npc, targetId)) {
                    toastr.success(`Копия «${npc.name}» создана в «${target.name}»`);
                    renderProfilesTab();
                }
            } else if (action === 'delete') {
                await deleteNpc(npc, () => {
                    renderProfilesTab();
                    openFolderOverlay(folder);
                });
            }
        });

        renderRoot();

        // Закрытие: клик мимо, Esc, скролл списка или ресайз
        setTimeout(() => {
            $(document).on('click.novaNpcMenu', function(e) {
                if (!$(e.target).closest('.nova-npc-menu, .nova-npc-menu-btn').length) closeNpcActionsMenu();
            });
            $(document).on('keydown.novaNpcMenu', function(e) {
                if (e.key !== 'Escape') return;
                // Esc внутри подменю — шаг назад, а не полное закрытие
                if ($menu.find('.nova-npc-submenu-header').length) renderRoot();
                else closeNpcActionsMenu();
            });
            $(window).on('resize.novaNpcMenu', closeNpcActionsMenu);
            $('#nova-view-folder-overlay').on('scroll.novaNpcMenu', closeNpcActionsMenu);
            $('#nova-view-folder-overlay .nova-content').on('scroll.novaNpcMenu', closeNpcActionsMenu);
        }, 0);
    }

    loadStylesheet();
    
    $(document).ready(() => {
        injectWandButton();
        migrateLegacySettings();
        loadSettings();
        loadFolders();

        // Персона в Таверне сменилась — активная NOVA-персона (если не запиннена
        // руками) должна подхватиться сама, без переоткрытия панели
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (ctx?.eventSource && ctx?.eventTypes?.PERSONA_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.PERSONA_CHANGED, () => {
                if ($('#nova-view-chars').hasClass('active')) renderCharsTab();
            });
        }

        // Чат сменился — лента/ЛС/отношения в памяти иначе продолжают указывать на
        // прежний чат до следующего открытия панели, а saveFeed() тем временем может
        // затереть НОВЫЙ чат данными старого (см. защиту в saveFeed самой). loadFeed()
        // тут держит loadedFeedChatId в норме почти всегда, а не только когда повезёт.
        if (ctx?.eventSource && ctx?.eventTypes?.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
                loadFeed();
                if ($('#nova-view-feed').hasClass('active')) renderFeed();
                if ($('#nova-view-dms').hasClass('active')) renderDMs();
                updateRelationshipBadge();
            });
        }
    });

    // --- HISTORY TAB ---
    /**
     * Все картинки текущего чата — из постов, ответов и личных сообщений.
     * Собирается на лету, а не хранится отдельным списком: так галерея не может
     * разойтись с лентой и не оставляет мёртвых записей после удаления поста.
     */
    // «Только NOVA» или «все». NOVA складывает свои картинки в user/images/NOVA —
    // чужой путь означает, что файл пришёл откуда-то ещё
    let galleryScope = 'nova';
    // Прячет свои же загруженные фотки — иногда в галерее интересны только
    // сгенерированные картинки персонажей, а не то, что сам туда прикрепил
    let hideUserPhotosInGallery = false;

    function isNovaImage(path) {
        return /(^|\/)user\/images\/NOVA\//i.test(String(path || '')) || String(path || '').startsWith('user/images/NOVA/');
    }

    function collectGalleryItems() {
        const items = [];

        const walkReplies = (replies, post) => {
            (replies || []).forEach(r => {
                if (!r) return;
                // reply — ссылка на САМ ответ, а не на пост: у ответа своя история версий
                // (imageVersions). Раньше здесь хранился только post, и открытие ответа
                // из галереи показывало картинку поста — обычно с одной, «первой» версией
                if (r.image) items.push({ image: r.image, thumbnail: r.thumbnail, prompt: r.imagePrompt, author: r.name || r.handle, source: 'Ответ', reply: r, post, userPhoto: !!r.userPhoto });
                walkReplies(r.replies, post);
            });
        };

        (feedPosts || []).forEach(post => {
            if (!post) return;
            if (post.image) items.push({ image: post.image, thumbnail: post.thumbnail, prompt: post.imagePrompt, author: post.name || post.handle, source: 'Пост', post, userPhoto: !!post.userPhoto });
            walkReplies(post.replies, post);
        });

        (dmThreads || []).forEach(thread => {
            (thread?.messages || []).forEach(msg => {
                if (!msg?.image) return;
                const who = msg.sender === 'user' ? 'Вы' : (msg.sender_name || thread.name);
                items.push({ image: msg.image, thumbnail: msg.thumbnail, prompt: msg.imagePrompt, author: who, source: `Личка · ${thread.name}`, msg: msg, userPhoto: !!msg.userPhoto });
            });
        });

        let filtered = galleryScope === 'nova' ? items.filter(i => isNovaImage(i.image)) : items;
        if (hideUserPhotosInGallery) filtered = filtered.filter(i => !i.userPhoto);
        return filtered;
    }

    function renderGalleryTab() {
        const $grid = $('#nova-gallery-grid');
        if (!$grid.length) return;
        $grid.empty();

        // Вешаем до раннего выхода по пустому списку: иначе в пустой галерее
        // переключатель мёртв, а именно там он и нужен, чтобы увидеть остальное
        $(document).off('click', '.nova-gallery-scope').on('click', '.nova-gallery-scope', function() {
            galleryScope = $(this).data('scope') === 'all' ? 'all' : 'nova';
            renderGalleryTab();
        });

        $('.nova-gallery-scope').each(function() {
            const on = $(this).data('scope') === galleryScope;
            $(this).toggleClass('active', on)
                .css({ background: on ? 'var(--nova-accent)' : 'transparent', color: on ? '#fff' : 'var(--nova-text-muted)' });
        });

        $(document).off('click', '#nova-gallery-hide-user').on('click', '#nova-gallery-hide-user', function() {
            hideUserPhotosInGallery = !hideUserPhotosInGallery;
            renderGalleryTab();
        });
        $('#nova-gallery-hide-user').css({
            background: hideUserPhotosInGallery ? 'var(--nova-accent)' : 'transparent',
            color: hideUserPhotosInGallery ? '#fff' : 'var(--nova-text-muted)',
            borderColor: hideUserPhotosInGallery ? 'var(--nova-accent)' : 'var(--nova-border)',
        });

        const items = collectGalleryItems();
        $('#nova-gallery-count').text(items.length ? pluralRu(items.length, 'изображение', 'изображения', 'изображений') : '');

        if (!items.length) {
            $grid.append(`<div style="grid-column: 1 / -1; color: var(--nova-text-muted); text-align: center; padding: 40px; line-height: 1.5;">
                Пока пусто.<br>${galleryScope === 'nova'
                    ? 'Здесь будут картинки, созданные и приложенные в NOVA.'
                    : 'Здесь будут все картинки этого чата.'}
            </div>`);
            return;
        }

        items.forEach((item, index) => {
            // Подпись — описание от модели, если картинку рисовала она, иначе автор
            const caption = String(item.prompt || '').trim() || `${item.source} · ${item.author}`;
            const $cell = $(`
                <div class="nova-gallery-item" data-index="${index}" title="${escapeHtml(caption)}">
                    <img src="${item.thumbnail || item.image}" loading="lazy" alt="">
                    <div class="nova-gallery-caption">${escapeHtml(item.author || '')}</div>
                </div>
            `);
            $grid.append($cell);
        });

        // Реальные объекты (пост/ответ/сообщение), а не обёртки items[] — только
        // они дают locateItemContext возможность найти вещь и обновить открытый
        // тред/переписку, да и листать галерею вперёд-назад нужно по ним же
        const realItems = items.map(it => it.reply || it.post || it.msg || { image: it.image, prompt: it.prompt });

        $grid.off('click', '.nova-gallery-item').on('click', '.nova-gallery-item', function() {
            const index = $(this).data('index');
            const item = realItems[index];
            if (item) openImageViewer(item, { items: realItems, index });
        });
    }

    function renderRelationshipsTab() {
        const $picker = $('#nova-relationship-picker');
        const $list = $('#nova-relationship-list');
        if (!$picker.length || !$list.length) return;

        const rel = getRelationshipSettings();
        // Открыли вкладку — значит увидели изменения. Бейдж на иконке гасим тут же,
        // а не по отдельному клику: так же ведут себя непрочитанные ЛС.
        if (rel.unreadCount) {
            rel.unreadCount = 0;
            saveRelationshipSettings();
        }
        updateRelationshipBadge();

        const profiles = getActiveProfiles().filter(p => !p.isUser);

        $picker.empty();
        if (!profiles.length) {
            $picker.append(`<div style="color: var(--nova-text-muted); font-size: 13px; opacity: 0.75; padding: 4px 0;">Нет активных персонажей и NPC.</div>`);
        } else {
            profiles.forEach(p => {
                const key = normHandle(p.handle);
                $picker.append(`
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 5px 0; min-width: 0;">
                        <input type="checkbox" class="nova-relationship-track" data-handle="${escapeHtml(key)}" ${rel.tracked.includes(key) ? 'checked' : ''} style="accent-color: var(--nova-accent); width: 17px; height: 17px; flex-shrink: 0;">
                        <span class="nova-truncate" style="font-size: 14px;">${escapeHtml(p.name)}</span>
                        <span class="nova-truncate" style="font-size: 12px; color: var(--nova-text-muted); flex-shrink: 1;">${escapeHtml(p.handle)}</span>
                    </label>
                `);
            });
        }

        $list.empty();
        const tracked = profiles.filter(p => rel.tracked.includes(normHandle(p.handle)));
        if (!tracked.length) {
            $list.append(`<div style="color: var(--nova-text-muted); text-align: center; padding: 32px 16px; line-height: 1.5;">
                Пока никто не отслеживается.<br>Отметьте героев выше — их симпатия появится здесь.
            </div>`);
            return;
        }

        tracked.forEach(p => {
            const rec = getRelationshipRecord(p.handle);
            // Статус от модели приоритетнее — он приходит, только когда ей есть что
            // сказать точнее числа. Иначе — вычисленный из симпатии ярлык.
            const status = rec.status || relationshipStatusForAffinity(rec.affinity);
            const color = relationshipColorForAffinity(rec.affinity);
            const avatarHtml = p.avatar
                ? `<img src="${p.avatar}" class="nova-profile-avatar" onerror="this.style.display='none'">`
                : `<div class="nova-profile-avatar" style="background-color: ${p.color || '#333'}; color: white; font-weight: bold; font-size: 18px;">${(p.name || '?').charAt(0).toUpperCase()}</div>`;

            // Дельта — только у самой реакции, которая её вызвала. Раньше та же
            // цифра дублировалась ещё и в шапке карточки рядом с процентом, что
            // выглядело избыточно и без единиц измерения было непонятно к чему
            const deltaChip = delta => {
                if (!delta) return '';
                const deltaColor = delta > 0 ? '#8ecf9e' : '#e0888f';
                return `<span style="font-size: 11px; font-weight: 700; color: ${deltaColor}; flex-shrink: 0;">${delta > 0 ? '+' : ''}${formatAffinity(delta)}</span>`;
            };

            const renderReaction = r => `
                <div style="display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--nova-text-muted); padding: 8px 10px; background: rgba(0,0,0,0.18); border-radius: 8px; line-height: 1.4;">
                    ${deltaChip(r.delta)}<span style="flex: 1; min-width: 0;">${escapeHtml(r.text)}</span>
                </div>
            `;
            // Только 3 последние сразу — остальное копится в истории (до 50 штук),
            // но захламляло бы карточку. Разворачивается по клику.
            const visibleReactions = rec.reactions.slice(0, 3);
            const extraReactions = rec.reactions.slice(3);
            const reactionsHtml = visibleReactions.map(renderReaction).join('')
                || `<div style="font-size: 12px; color: var(--nova-text-muted); opacity: 0.6;">Пока нет реакций.</div>`;
            const moreHtml = extraReactions.length ? `
                <div class="nova-relationship-toggle-more" style="font-size: 12px; color: var(--nova-accent); cursor: pointer; padding-top: 2px;">Ещё ${extraReactions.length}</div>
                <div class="nova-relationship-more" style="display: none; flex-direction: column; gap: 6px;">${extraReactions.map(renderReaction).join('')}</div>
            ` : '';

            // Число упирается в потолок/дно (0/100) и дальше просто не двигается,
            // но событие всё равно настоящее — оно уходит в rec.tier (см.
            // absorbRelationshipTag). Реальный счётчик уровня, а не разовая вспышка:
            // растёт с каждым новым тёплым моментом уже на максимуме, симметрично
            // падает на самом дне.
            const tier = rec.tier || 0;
            const tierBadge = tier > 0
                ? ` <span class="nova-relationship-tier-badge positive" title="Уровень отношений сверх 100% — цифра сама больше не растёт, а это продолжает">✨ ур. ${tier}</span>`
                : tier < 0
                ? ` <span class="nova-relationship-tier-badge negative" title="Уровень отношений глубже дна — цифра сама больше не падает, а это продолжает">💔 ур. ${Math.abs(tier)}</span>`
                : '';

            // Статус — на своей строке во всю ширину, а не втиснут в узкую правую
            // колонку рядом с процентом: длинная фраза от модели («лучшие друзья
            // с ноткой паники») там выталкивала имя персонажа в обрезанное «Трафа…»
            $list.append(`
                <div class="nova-profile-card" data-handle="${escapeHtml(normHandle(p.handle))}" style="padding: 12px; display: flex; flex-direction: column; gap: 8px; border-left: 3px solid ${color};">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        ${avatarHtml}
                        <div style="flex: 1; min-width: 0;">
                            <div class="nova-profile-name">${escapeHtml(p.name)}</div>
                            <div class="nova-profile-handle">${escapeHtml(p.handle)}</div>
                        </div>
                        <div style="font-weight: 700; color: ${color}; font-size: 15px; flex-shrink: 0;">${formatAffinity(rec.affinity)}%</div>
                        <div class="nova-relationship-reassess" title="Пересчитать по контексту РП" style="cursor: pointer; color: var(--nova-text-muted); opacity: 0.6; padding: 4px; flex-shrink: 0;">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                        </div>
                        <div class="nova-relationship-reset" title="Сбросить отношения" style="cursor: pointer; color: var(--nova-text-muted); opacity: 0.6; padding: 4px; flex-shrink: 0;">
                            <i class="fa-solid fa-rotate-left"></i>
                        </div>
                    </div>
                    <div style="font-size: 12px; color: var(--nova-text-muted); padding-left: 52px; line-height: 1.4; word-break: break-word;">${escapeHtml(status)}${tierBadge}</div>
                    <div style="height: 6px; border-radius: 3px; background: var(--nova-surface-hover); overflow: hidden;">
                        <div style="height: 100%; width: ${rec.affinity}%; background: ${color};"></div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        ${reactionsHtml}
                        ${moreHtml}
                    </div>
                </div>
            `);
        });
    }

    /**
     * Пересчитывает симпатию персонажа заново по всему контексту РП — в отличие от
     * обычных тегов, которые только докидывают дельту, тут модель прямо перезаписывает
     * число. Нужно, когда стартовая калибровка при первом теге промахнулась мимо
     * очевидного из карточки/сюжета — например, супруг стартовал с нейтральных 50%.
     */
    async function reassessRelationship(profile) {
        const chatContext = await getChatContext();
        const userProfile = getActiveProfiles().find(p => p.isUser) || { handle: '@user', name: 'Вы' };
        const profileInfo = profile.type === 'npc'
            ? `${profile.name} (${profile.handle}): ${profile.desc || ''} | Стиль: ${profile.style || ''}`
            : `${profile.name} (${profile.handle}): персонаж из текущего чата — характер и история определяются его картой персонажа.`;

        const prompt = NovaPrompts.relationshipReassessPrompt(profileInfo, chatContext, userProfile.handle);
        const data = await callAIForJson(prompt, [], d => d && Number.isFinite(Number(d.affinity)), 'Модель не вернула оценку');
        const affinity = Number(data.affinity);

        const rec = getRelationshipRecord(profile.handle);
        rec.affinity = Math.max(0, Math.min(100, Math.round(affinity)));
        // Пересчёт — это свежая оценка с нуля по всей истории РП, а не ещё одно
        // событие поверх старого; накопленный сверх-уровень тут не при чём.
        rec.tier = 0;
        const status = String(data.status || '').trim();
        if (status) rec.status = status;
        const reason = String(data.reason || '').trim();
        if (reason) {
            rec.reactions.unshift({ id: `relev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: `Сейчас: ${reason}`, delta: 0, time: Date.now() });
            rec.reactions = rec.reactions.slice(0, 50);
        }
        saveRelationshipSettings();
        renderRelationshipsTab();
    }

    function bindRelationshipEvents() {
        $(document).on('click', '.nova-relationship-toggle-more', function() {
            const $more = $(this).next('.nova-relationship-more');
            const wasOpen = $more.is(':visible');
            $more.slideToggle(150);
            $(this).text(wasOpen ? `Ещё ${$more.children().length}` : 'Свернуть');
        });
        $(document).on('change', '.nova-relationship-track', function() {
            const rel = getRelationshipSettings();
            const key = String($(this).attr('data-handle') || '');
            if (!key) return;
            if ($(this).is(':checked')) {
                if (!rel.tracked.includes(key)) rel.tracked.push(key);
            } else {
                rel.tracked = rel.tracked.filter(h => h !== key);
            }
            saveRelationshipSettings();
            renderRelationshipsTab();
        });

        // Стартовая калибровка при первом теге иногда промахивается мимо очевидного
        // из карточки/сюжета (например, супруг стартует с нейтральных 50%) — эта
        // кнопка просит модель оценить отношения заново по всему контексту РП.
        $(document).on('click', '.nova-relationship-reassess', async function(e) {
            e.stopPropagation();
            const $btn = $(this);
            if ($btn.data('busy')) return;
            const $card = $btn.closest('.nova-profile-card');
            const handle = $card.attr('data-handle');
            if (!handle) return;
            const profile = getActiveProfiles().find(ap => normHandle(ap.handle) === handle);
            if (!profile) return;

            $btn.data('busy', true);
            const $icon = $btn.find('i').removeClass('fa-wand-magic-sparkles').addClass('fa-spinner fa-spin');
            try {
                await reassessRelationship(profile);
                toastr.success(`Отношения с «${profile.name}» пересчитаны`, 'NOVA');
            } catch (err) {
                console.error('[NOVA] Не удалось пересчитать отношения', err);
                toastr.error('Не удалось пересчитать: ' + (err.message || ''));
            } finally {
                $icon.removeClass('fa-spinner fa-spin').addClass('fa-wand-magic-sparkles');
                $btn.data('busy', false);
            }
        });

        // Сброс — на случай тестовых прогонов или если герой свернул не туда:
        // возвращает персонажа к нейтральным 50% и стирает историю реакций.
        // Ссылки item.relationshipEvent на старые посты просто перестанут что-то
        // находить при удалении — это безвредно, не ошибка.
        $(document).on('click', '.nova-relationship-reset', function(e) {
            e.stopPropagation();
            const $card = $(this).closest('.nova-profile-card');
            const handle = $card.attr('data-handle');
            if (!handle) return;
            const name = $card.find('.nova-profile-name').text() || handle;
            novaConfirm(`Сбросить отношения с «${name}»? Симпатия вернётся к 50%, история реакций сотрётся.`, () => {
                const rel = getRelationshipSettings();
                delete rel.data[handle];
                saveRelationshipSettings();
                renderRelationshipsTab();
            });
        });
    }

    function renderFeedBackups() {
        const $list = $('#nova-feed-backups-list');
        if (!$list.length) return;
        $list.empty();

        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const chatId = getCurrentChatId();
        const backups = ctx?.extensionSettings?.NOVA?.chatFeedBackups?.[chatId] || [];
        if (!backups.length) {
            $list.append('<div style="color: var(--nova-text-muted); font-size: 13px;">Пока нет резервных копий для этого чата.</div>');
            return;
        }
        // Новые сверху — так актуальные варианты восстановления видно без прокрутки
        backups.forEach((b, idx) => {
            const date = new Date(b.time).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const $row = $(`
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; background: var(--nova-surface-hover); border-radius:8px; font-size:13px;">
                    <span>${date} — ${b.postsCount} постов, ${b.threadsCount} переписок</span>
                    <button class="nova-feed-backup-restore-btn" style="background: var(--nova-accent); color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:12px; flex-shrink:0;">Восстановить</button>
                </div>`);
            $row.find('.nova-feed-backup-restore-btn').on('click', () => restoreFeedBackup(chatId, idx));
            $list.prepend($row);
        });
    }

    function restoreFeedBackup(chatId, idx) {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const backups = ctx?.extensionSettings?.NOVA?.chatFeedBackups?.[chatId] || [];
        const backup = backups[idx];
        if (!backup) return;
        const date = new Date(backup.time).toLocaleString('ru-RU');
        novaConfirm(`Восстановить снимок от ${date} (${backup.postsCount} постов, ${backup.threadsCount} переписок)? Текущее состояние ленты и переписки в этом чате будет заменено.`, () => {
            if (!ctx.extensionSettings.NOVA.chatFeeds) ctx.extensionSettings.NOVA.chatFeeds = {};
            ctx.extensionSettings.NOVA.chatFeeds[chatId] = structuredClone(backup.data);
            ctx.saveSettingsDebounced();
            if (chatId === getCurrentChatId()) {
                loadFeed();
                renderFeed();
                renderDMs();
            }
            toastr.success('Лента восстановлена из резервной копии');
        }, 'Восстановить', 'var(--nova-accent)');
    }

    function renderHistoryTab() {
        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!stContext || !stContext.chat) return;

        const historyContainer = $('#nova-history-list');
        if (!historyContainer.length) return;
        historyContainer.empty();

        let count = 0;

        stContext.chat.forEach((msg, index) => {
            if (!msg.mes) return;
            const localRegex = contextMarkerRegex(true);
            let match;
            let subIndex = 0;

            while ((match = localRegex.exec(msg.mes)) !== null) {
                count++;
                const kind = CONTEXT_KINDS[contextKindByLabel(match[1])];
                const summaryText = match[2];

                const card = $(`
                    <div class="nova-history-card" style="background: var(--nova-surface-hover); border-radius: 12px; padding: 12px; border: 1px solid var(--nova-border); border-left: 3px solid ${kind.color}; position: relative;">
                        <div style="font-size: 12px; color: var(--nova-text-muted); margin-bottom: 6px;">
                            <span style="color: ${kind.color}; font-weight: 700;">${kind.title}</span> · сообщение #${index}, блок ${subIndex + 1}
                        </div>
                        <textarea class="nova-history-textarea" data-index="${index}" data-subindex="${subIndex}" style="box-sizing: border-box; width: 100%; min-height: 60px; background: rgba(0,0,0,0.2); border: 1px solid var(--nova-border); border-radius: 8px; color: var(--nova-text); padding: 8px; font-family: inherit; resize: vertical;">${summaryText}</textarea>
                        
                        <div style="display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end;">
                            <button class="nova-history-jump-btn" data-index="${index}" style="background: var(--nova-surface); border: 1px solid var(--nova-border); color: var(--nova-text); padding: 6px 12px; border-radius: 8px; cursor: pointer;" title="Перейти к сообщению"><i class="fa-solid fa-crosshairs"></i></button>
                            <button class="nova-history-save-btn" data-index="${index}" data-subindex="${subIndex}" style="background: var(--nova-accent); border: none; color: white; padding: 6px 12px; border-radius: 8px; cursor: pointer;" title="Сохранить изменения"><i class="fa-solid fa-check"></i></button>
                            <button class="nova-history-delete-btn" data-index="${index}" data-subindex="${subIndex}" style="background: rgba(255,50,50,0.2); border: 1px solid rgba(255,50,50,0.5); color: #ff5555; padding: 6px 12px; border-radius: 8px; cursor: pointer;" title="Удалить из памяти"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                `);
                historyContainer.append(card);
                subIndex++;
            }
        });

        if (count === 0) {
            historyContainer.append(`<div style="text-align: center; color: var(--nova-text-muted); padding: 20px;">Пока нет сохранённого контекста.</div>`);
        }
    }

    // --- LONG PRESS: КОНТЕКСТНОЕ МЕНЮ ПОСТА/ОТВЕТА/DM-СООБЩЕНИЯ ---

    /** Достаёт реальный объект поста/ответа из feedPosts по атрибутам зажатого элемента. */
    function resolveLongPressTarget($el) {
        const itemType = $el.data('itemType');

        if (itemType === 'post' || itemType === 'main-post') {
            const index = Number($el.data('index'));
            const post = feedPosts[index];
            return post ? { kind: 'feed-post', item: post, feedIndex: index } : null;
        }

        if (itemType === 'reply') {
            const topIndex = Number($el.data('topIndex'));
            const pathParts = String($el.data('replyPath') || '').split(',').filter(Boolean).map(Number);
            let container = feedPosts[topIndex];
            let parentArray = container?.replies;
            for (let i = 0; i < pathParts.length - 1; i++) {
                container = parentArray?.[pathParts[i]];
                parentArray = container?.replies;
            }
            if (!parentArray || !pathParts.length) return null;
            const replyIndex = pathParts[pathParts.length - 1];
            const reply = parentArray[replyIndex];
            return reply ? { kind: 'feed-reply', item: reply, feedIndex: topIndex, parentArray, replyIndex } : null;
        }

        return null;
    }

    function isOwnFeedItem(item) {
        const userProfile = getActiveProfiles().find(p => p.isUser);
        return !!userProfile && !!item?.handle && normHandle(item.handle) === normHandle(userProfile.handle);
    }

    function deleteLongPressTarget(target) {
        const wasOpenAsSinglePost = $('#nova-view-single-post').hasClass('active');
        if (target.kind === 'feed-post') {
            revertRelationshipsDeep(feedPosts[target.feedIndex]);
            feedPosts.splice(target.feedIndex, 1);
        } else {
            revertRelationshipsDeep(target.parentArray[target.replyIndex]);
            target.parentArray.splice(target.replyIndex, 1);
        }
        saveFeed();
        // Верхний пост удалили, пока был открыт его отдельный вид — там больше
        // нечего показывать, закрываем, а не оставляем показывать несуществующий индекс
        if (wasOpenAsSinglePost && target.kind === 'feed-post') {
            $('#nova-view-single-post').removeClass('active');
        } else if (wasOpenAsSinglePost) {
            openSinglePost(target.feedIndex);
        }
        renderFeed();
        toastr.success('Удалено.');
    }

    /**
     * Убирает СВОЙ пост и запрашивает у модели новую реакцию на тот же текст/фото —
     * не нужно вручную удалять и свой пост, и все ответы персонажей, чтобы переписать заново.
     */
    async function regenerateOwnFeedPost(feedIndex) {
        const post = feedPosts[feedIndex];
        if (!post) return;
        const text = String(post.text || '');
        const imagePath = post.image || '';
        const imageThumb = post.thumbnail || '';

        // Перечитываем сохранённый файл в data URL: без него модель не увидит фото
        // заново и отреагирует вслепую, хотя картинка формально осталась при посте
        let imageDataUrl = '';
        if (imagePath) {
            try {
                imageDataUrl = `data:image/jpeg;base64,${await referenceToBase64(imagePath)}`;
            } catch (e) {
                console.warn('[NOVA] Не удалось перечитать фото поста для перегенерации', e);
            }
        }

        const wasOpenAsSinglePost = $('#nova-view-single-post').hasClass('active');
        // Реакции NPC на этот пост сгенерировались в ТОЙ ЖЕ пачке (общий batchId) —
        // они отдельные посты верхнего уровня, а не replies этого поста. Удаляя
        // только сам пост, старые твиты-реакции оставались висеть в ленте рядом
        // с новыми после перегенерации.
        const batchId = post.batchId;
        const toRemove = batchId ? feedPosts.filter(p => p.batchId === batchId) : [post];
        toRemove.forEach(revertRelationshipsDeep);
        feedPosts = batchId ? feedPosts.filter(p => p.batchId !== batchId) : feedPosts.filter(p => p !== post);
        saveFeed();
        if (wasOpenAsSinglePost) $('#nova-view-single-post').removeClass('active');
        renderFeed();

        await generateFeed(text, { imagePath, imageThumb, imageDataUrl });
    }

    /** Один и тот же список кнопок для постов, ответов и DM-сообщений. */
    function showItemActionMenu(actions) {
        $('#nova-item-action-menu').remove();
        if (!actions.length) return;

        const $menu = $(`
            <div id="nova-item-action-menu" style="display: flex; position: absolute; inset: 0; z-index: 9999; justify-content: center; align-items: flex-end; background: rgba(0,0,0,0.5); padding: 20px; box-sizing: border-box;">
                <div class="nova-item-action-list" style="background: var(--nova-dm-card, var(--nova-surface)); border: 1px solid var(--nova-dm-border, var(--nova-border)); border-radius: 16px; padding: 12px; width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 4px;"></div>
            </div>
        `);
        // find('div > div') возвращает пусто, пока $menu не вставлен в document —
        // комбинаторы вроде ">" не матчатся на отсоединённом узле в этой версии
        // jQuery, а простой селектор по классу работает всегда. Из-за этого меню
        // рисовалось пустым: сама обёртка появлялась, а кнопки внутрь не попадали.
        const $list = $menu.find('.nova-item-action-list');
        actions.forEach(action => {
            const $btn = $(`
                <button style="display: flex; align-items: center; gap: 12px; background: transparent; border: none; color: ${action.danger ? '#f44336' : 'var(--nova-dm-card-text, var(--nova-text))'}; padding: 12px; border-radius: 10px; cursor: pointer; font-size: 15px; text-align: left; width: 100%;">
                    <i class="fa-solid ${action.icon}" style="width: 20px;"></i> ${escapeHtml(action.label)}
                </button>
            `);
            $btn.on('click', () => { $menu.remove(); action.onClick(); });
            $list.append($btn);
        });

        $menu.on('click', (e) => { if (e.target === $menu[0]) $menu.remove(); });
        $('#nova-backdrop').append($menu);
    }

    function showDeleteContextMenu(e, $el) {
        const dmMsg = resolveLongPressDMTarget($el);
        if (dmMsg) {
            const actions = [
                { label: 'Удалить', icon: 'fa-trash', danger: true, onClick: () => deleteLongPressDMTarget(dmMsg) },
            ];
            // Аватарка/обои/тема — уже применённое действие с собственным revert-путём
            // (см. revertWallpaperIfDeleted/revertThemeIfDeleted), а не просто текст,
            // который можно тупо пересобрать через generateDMResponse — плашка карточки
            // отвязана от реального состояния треда (thread.wallpaper/theme), и без
            // повторного применения самого действия перегенерация ломала сообщение
            // (оно пересобиралось пустым и зависало в отправке).
            const isSpecialCard = !!(dmMsg.message.avatarSuggestion || dmMsg.message.wallpaperChange || dmMsg.message.themeChange);
            if (dmMsg.message.sender === 'user' && !isSpecialCard) {
                actions.unshift({ label: 'Перегенерировать', icon: 'fa-rotate', onClick: () => regenerateOwnDMMessage(dmMsg) });
            }
            showItemActionMenu(actions);
            return;
        }

        const target = resolveLongPressTarget($el);
        if (!target) return;

        const actions = [
            { label: 'Удалить', icon: 'fa-trash', danger: true, onClick: () => deleteLongPressTarget(target) },
        ];
        // Перегенерация — только для СВОИХ постов. У ответа своей реакции модель
        // не переписывает отдельно, только весь пост целиком со всей веткой.
        if (target.kind === 'feed-post' && isOwnFeedItem(target.item)) {
            actions.unshift({
                label: 'Перегенерировать',
                icon: 'fa-rotate',
                onClick: () => regenerateOwnFeedPost(target.feedIndex),
            });
        }
        showItemActionMenu(actions);
    }

    // --- LONG PRESS: DM-СООБЩЕНИЯ (своя ветка, у них нет .nova-long-pressable) ---

    function resolveLongPressDMTarget($el) {
        const $wrapper = $el.closest('.nova-dm-message-wrapper');
        if (!$wrapper.length) return null;
        const handle = $('#nova-view-single-dm').attr('data-thread-handle');
        const threadIndex = dmThreads.findIndex(t => t.handle === handle);
        const thread = dmThreads[threadIndex];
        const msgIndex = Number($wrapper.data('msgIndex'));
        const message = thread?.messages?.[msgIndex];
        return message ? { threadIndex, thread, msgIndex, message } : null;
    }

    function deleteLongPressDMTarget(target) {
        revertRelationshipsDeep(target.message);
        revertWallpaperIfDeleted(target.thread, target.message);
        revertThemeIfDeleted(target.thread, target.message);
        target.thread.messages.splice(target.msgIndex, 1);
        saveFeed();
        openSingleDM(target.threadIndex);
        toastr.success('Удалено.');
    }

    /** Своё сообщение убираем вместе с тем, что персонаж ответил НА НЕГО (до следующего своего). */
    async function regenerateOwnDMMessage(target) {
        const { thread, msgIndex } = target;
        const msg = thread.messages[msgIndex];
        if (!msg) return;

        // Несколько строк, отправленных разом через Enter (см. #nova-single-dm-reply-btn),
        // лежат в треде как отдельные подряд идущие сообщения юзера без ответа между
        // ними — клик на ЛЮБУЮ строку такой группы должен поднимать весь блок целиком,
        // а не только кликнутую строку, иначе соседние строки остаются висеть без
        // ответа модели (раньше это работало только если жать на самую последнюю).
        let start = msgIndex;
        while (start > 0 && thread.messages[start - 1].sender === 'user') start--;
        let userEnd = msgIndex;
        while (userEnd + 1 < thread.messages.length && thread.messages[userEnd + 1].sender === 'user') userEnd++;

        const batch = [];
        for (const m of thread.messages.slice(start, userEnd + 1)) {
            let imageDataUrl = '';
            if (m.image) {
                try {
                    imageDataUrl = `data:image/jpeg;base64,${await referenceToBase64(m.image)}`;
                } catch (e) {
                    console.warn('[NOVA] Не удалось перечитать фото сообщения для перегенерации', e);
                }
            }
            // Карточка перевода денег живёт в text: '' + transfer: {...} — если не
            // перенести transfer сюда, пересборка ниже даст пустое сообщение без
            // текста И без карточки, которое зависает в отправке (баг с "ломается").
            batch.push({ text: String(m.text || ''), imageDataUrl, transfer: m.transfer ? { ...m.transfer } : undefined });
        }

        // Убираем весь блок юзера и всё, что шло ПОСЛЕ него до следующего сообщения
        // юзера — это реакция именно на него, а не вся дальнейшая переписка
        let end = userEnd + 1;
        while (end < thread.messages.length && thread.messages[end].sender !== 'user') end++;
        thread.messages.slice(start, end).forEach(m => {
            revertRelationshipsDeep(m);
            revertWallpaperIfDeleted(thread, m);
            revertThemeIfDeleted(thread, m);
        });
        thread.messages.splice(start, end - start);
        saveFeed();
        openSingleDM(target.threadIndex);

        // Картинку отдаём модели один раз — она относится к первому сообщению серии
        // (см. тот же принцип в отправке новых сообщений)
        let firstImageDataUrl = null;
        for (const item of batch) {
            let imagePathForNext = '';
            let imageThumbForNext = '';
            if (item.imageDataUrl) {
                try {
                    const uploaded = await uploadNovaImageWithThumbnail(item.imageDataUrl);
                    imagePathForNext = uploaded.image;
                    imageThumbForNext = uploaded.thumbnail;
                    if (!firstImageDataUrl) firstImageDataUrl = item.imageDataUrl;
                } catch (e) {
                    console.warn('[NOVA] Не удалось повторно сохранить фото сообщения', e);
                }
            }
            thread.messages.push({
                text: item.text,
                image: imagePathForNext || undefined,
                thumbnail: imageThumbForNext || undefined,
                userPhoto: !!imagePathForNext || undefined,
                transfer: item.transfer,
                sender: 'user',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
        }
        saveFeed();
        openSingleDM(target.threadIndex);

        await generateDMResponse(target.threadIndex, firstImageDataUrl);
    }

    let longPressTimer;
    let longPressStartX = 0;
    let longPressStartY = 0;
    // Элемент текущего долгого нажатия — нужен слушателю scroll ниже, у которого
    // нет доступа к делегированному $(this).
    let longPressEl = null;
    // Если палец за время удержания уехал дальше этого порога — это скролл/свайп,
    // а не долгое нажатие на месте, таймер отменяется.
    const LONG_PRESS_MOVE_THRESHOLD = 10;
    $(document).on('pointerdown', '.nova-long-pressable, .nova-dm-message-wrapper', function(e) {
        // Вложенный ответ (ответ на ответ) физически лежит ВНУТРИ .nova-long-pressable
        // родителя — без остановки распространения делегированный обработчик сработал
        // бы ДВАЖДЫ на одно и то же касание (для дочернего и для родительского блока).
        // Оба используют общие longPressTimer/longPressEl, и второе срабатывание
        // затирало ссылку на таймер первого — тот таймер уже никто не мог отменить,
        // и он стрелял через 600мс, что бы палец ни делал дальше.
        e.stopPropagation();
        if (e.originalEvent && e.originalEvent.button === 2) return;
        const $el = $(this);
        if (feedSelectMode && $el.hasClass('nova-feed-post')) return;
        if (replySelectMode && $el.hasClass('nova-reply-wrapper')) return;
        if ($(this).hasClass('nova-dm-message-wrapper') && $('#nova-single-dm-messages').hasClass('delete-mode')) return;

        // На картинке Android Chrome готовит своё нативное меню («сохранить», «поделиться»)
        // ПАРАЛЛЕЛЬНО с нашим таймером — если ждать 600 мс и ставить preventDefault только
        // на contextmenu ПОСЛЕ срабатывания таймера, нативное меню чаще всего успевает
        // выскочить первым. preventDefault тут же, в pointerdown, глушит его с самого
        // начала жеста и не мешает обычному короткому тапу — click всё равно долетает.
        if (e.target && e.target.tagName === 'IMG') e.preventDefault();

        longPressStartX = e.clientX;
        longPressStartY = e.clientY;
        longPressEl = $el;
        $el.data('longPressFired', false);
        $el.data('dragged', false);
        longPressTimer = setTimeout(() => {
            $el.data('longPressFired', true);
            longPressEl = null;
            showDeleteContextMenu(e, $el);
        }, 600);
    }).on('pointermove', '.nova-long-pressable, .nova-dm-message-wrapper', function(e) {
        e.stopPropagation();
        const dx = e.clientX - longPressStartX;
        const dy = e.clientY - longPressStartY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) {
            clearTimeout(longPressTimer);
            $(this).data('dragged', true);
            longPressEl = null;
        }
    }).on('pointerup pointerleave pointercancel', '.nova-long-pressable, .nova-dm-message-wrapper', function(e) {
        e.stopPropagation();
        clearTimeout(longPressTimer);
        longPressEl = null;
    });

    // Подстраховка поверх pointermove: на тачскринах при медленной прокрутке список
    // реально едет, а палец за время удержания может не выехать за 10px — движение
    // копится маленькими шагами дольше, чем идёт таймер. pointermove в таком случае
    // не спасает, а вот сам факт скролла контейнера — надёжный сигнал «это не долгое
    // нажатие». scroll не всплывает, поэтому слушаем document на фазе перехвата —
    // так долетает scroll от ЛЮБОГО прокручиваемого предка.
    document.addEventListener('scroll', () => {
        if (!longPressEl) return;
        clearTimeout(longPressTimer);
        longPressEl.data('dragged', true);
        longPressEl = null;
    }, true);

    document.addEventListener('click', function(e) {
        const $el = $(e.target).closest('.nova-long-pressable, .nova-dm-message-wrapper');
        if ($el.length && $el.data('longPressFired')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true); // Capture phase to intercept before specific handlers

    document.addEventListener('contextmenu', function(e) {
        const $el = $(e.target).closest('.nova-long-pressable, .nova-dm-message-wrapper');
        if ($el.length && $el.data('longPressFired')) {
            e.preventDefault();
        }
    }, true);

})();
