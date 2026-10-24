(function () {
    // Revenge evals this as `return <file>`, so the file must start with "(" on line 1.
    const { metro, patcher, commands, plugin, logger } = vendetta;
    const { React } = metro.common;
    const h = React.createElement;

    const StickersStore = metro.findByStoreName("StickersStore");
    const GuildStore = metro.findByStoreName("GuildStore");
    const SelectedGuildStore = metro.findByStoreName("SelectedGuildStore");
    const messageUtil = metro.findByProps("sendBotMessage");

    const MAX_STICKERS = 3;
    const STRING_OPTION = 3;
    const TRIGGERS = {
        colon: { open: ":", close: ":" },
        semicolon: { open: ";", close: ";" },
        prefixed: { open: "s:", close: ":" },
    };

    const store = plugin.storage;
    store.inlineSyntax ??= true;
    store.trigger ??= "colon";
    store.commandChoices ??= true;

    // Discord's default packs only load once the picker opens, so grab them ourselves
    let defaultPackStickers = [];

    async function loadDefaultPacks() {
        try {
            let packs = StickersStore.getPremiumPacks?.() ?? [];
            if (!packs.length) {
                const http = metro.findByProps("getAPIBaseURL", "get");
                const res = await http.get({ url: "/sticker-packs" });
                packs = res.body.sticker_packs;
            }
            defaultPackStickers = packs.flatMap(p => p.stickers);
        } catch (e) {
            logger.warn("Couldn't load default sticker packs", e);
        }
    }

    function getAllEntries() {
        const currentGuild = SelectedGuildStore.getGuildId();
        const guildEntries = [];

        for (const [guildId, stickers] of StickersStore.getAllGuildStickers()) {
            const source = GuildStore.getGuild(guildId)?.name ?? "Unknown server";
            for (const sticker of stickers) {
                if (sticker.available === false) continue;
                guildEntries.push({ sticker, source, guildId });
            }
        }

        // current server first, so it wins name collisions
        guildEntries.sort((a, b) => Number(b.guildId === currentGuild) - Number(a.guildId === currentGuild));

        return [
            ...guildEntries,
            ...defaultPackStickers.map(sticker => ({ sticker, source: "Discord" })),
        ];
    }

    function findSticker(query) {
        const q = query.trim().toLowerCase();
        if (!q) return;
        const entries = getAllEntries();
        return entries.find(e => e.sticker.id === q)
            ?? entries.find(e => e.sticker.name.toLowerCase() === q);
    }

    function extractStickers(content, max) {
        const { open, close } = TRIGGERS[store.trigger] ?? TRIGGERS.colon;
        const ids = [];
        let out = "";
        let i = 0;

        while (ids.length < max) {
            const start = content.indexOf(open, i);
            if (start === -1) break;
            const nameStart = start + open.length;
            const end = content.indexOf(close, nameStart);
            if (end === -1) break;

            const name = content.slice(nameStart, end);
            // skip custom emoji markup like <:name:id> / <a:name:id>
            const isEmojiMarkup = /<a?$/.test(content.slice(Math.max(0, start - 2), start));
            const entry = !isEmojiMarkup && !name.includes("\n") && name.length <= 30 && findSticker(name);

            if (entry) {
                out += content.slice(i, start);
                ids.push(entry.sticker.id);
                i = end + close.length;
            } else {
                // the closing char might open the next token, so resume there
                out += content.slice(i, end);
                i = end;
            }
        }
        out += content.slice(i);

        return { content: out.replace(/[ \t]{2,}/g, " ").trim(), ids };
    }

    function sendSticker(channelId, stickerId) {
        messageUtil.sendMessage(
            channelId,
            { content: "", tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
            void 0,
            { stickerIds: [stickerId], nonce: Date.now().toString() }
        );
    }

    const nameOption = {
        name: "name",
        description: "Sticker name",
        type: STRING_OPTION,
        required: true,
    };

    if (store.commandChoices) {
        // getter so the list is rebuilt each time Discord reads it
        Object.defineProperty(nameOption, "choices", {
            enumerable: true,
            get: () => getAllEntries().map(({ sticker, source }) => {
                const label = `${sticker.name} (${source})`;
                return { name: label, displayName: label, label, value: sticker.id };
            }),
        });
    }

    const unpatches = [];

    function Settings() {
        vendetta.storage.useProxy(store);
        const { TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow } = metro.findByProps("TableSwitchRow", "TableRadioGroup");
        const { ScrollView } = metro.common.ReactNative;

        return h(ScrollView, { style: { padding: 16 } },
            h(TableRowGroup, { title: "Sticker Shortcuts" },
                h(TableSwitchRow, {
                    label: "Inline syntax",
                    subLabel: "Replace sticker tokens in messages with the sticker",
                    value: store.inlineSyntax,
                    onValueChange: v => store.inlineSyntax = v,
                }),
                h(TableSwitchRow, {
                    label: "Suggestions in /sticker",
                    subLabel: "Turn off if the list lags. Reload plugin after changing",
                    value: store.commandChoices,
                    onValueChange: v => store.commandChoices = v,
                }),
            ),
            h(TableRadioGroup, {
                title: "Inline trigger (real emojis win over :name:)",
                value: store.trigger,
                onChange: v => store.trigger = v,
            },
                h(TableRadioRow, { label: ":sticker name:", value: "colon" }),
                h(TableRadioRow, { label: ";sticker name;", value: "semicolon" }),
                h(TableRadioRow, { label: "s:sticker name:", value: "prefixed" }),
            ),
        );
    }

    return {
        onLoad() {
            loadDefaultPacks();

            unpatches.push(patcher.before("sendMessage", messageUtil, args => {
                if (!store.inlineSyntax) return;
                const msg = args[1];
                if (typeof msg?.content !== "string") return;

                const options = args[3] ?? {};
                const existing = options.stickerIds ?? [];
                const { content, ids } = extractStickers(msg.content, MAX_STICKERS - existing.length);
                if (!ids.length) return;

                msg.content = content;
                options.stickerIds = [...existing, ...ids];
                args[3] = options;
            }));

            unpatches.push(commands.registerCommand({
                name: "sticker",
                description: "Send a sticker by name",
                options: [nameOption],
                execute(args, ctx) {
                    const query = args.find(a => a.name === "name")?.value ?? "";
                    const entry = findSticker(query);

                    if (!entry) {
                        messageUtil.sendBotMessage(ctx.channel.id, `No sticker named **${query}** found.`);
                        return;
                    }

                    sendSticker(ctx.channel.id, entry.sticker.id);
                },
            }));
        },

        onUnload() {
            unpatches.forEach(u => u());
        },

        settings: Settings,
    };
})()
