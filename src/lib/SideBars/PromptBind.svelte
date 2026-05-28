<script lang="ts">
    import { DBState, selectedCharID, openPresetList, presetSelectCallback } from "src/ts/stores.svelte";
    import { language } from "src/lang";
    import { changeToPreset, getCurrentChat } from "src/ts/storage/database.svelte";
    import { alertConfirmMulti, alertSelect, notifySuccess } from "src/ts/alert";
    import { PinIcon, PinOffIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import ShButton from "../UI/GUI/ShButton.svelte";

    let currentChat = $derived(DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage])

    let boundPresetIndex = $derived.by(() => {
        const id = currentChat?.bindedBotPreset
        if (!id) return -1
        return DBState.db.botPresets.findIndex(p => p.id === id)
    })
    let isPresetBound = $derived(boundPresetIndex >= 0)
    let displayPreset = $derived(
        isPresetBound
            ? DBState.db.botPresets[boundPresetIndex]
            : DBState.db.botPresets[DBState.db.botPresetsId]
    )

    // Data-sync (옵션 A): when entering a chat whose bindedBotPreset resolves
    // to a valid preset, flip the global active preset so the rest of the
    // codebase — which only reads db.botPresetsId — automatically uses the
    // bound one. No-op when no binding or when already active.
    $effect(() => {
        if (boundPresetIndex >= 0 && DBState.db.botPresetsId !== boundPresetIndex) {
            changeToPreset(boundPresetIndex)
        }
    })

    function bindPreset(presetIndex: number) {
        const chat = getCurrentChat()
        if (!chat) return
        const preset = DBState.db.botPresets[presetIndex]
        if (!preset) return
        if (!preset.id) preset.id = v4()
        chat.bindedBotPreset = preset.id
        notifySuccess(language.promptBindedSuccess)
    }

    function unbindPreset() {
        const chat = getCurrentChat()
        if (!chat) return
        chat.bindedBotPreset = ''
        notifySuccess(language.promptUnbindedSuccess)
    }

    async function handlePresetBindClick() {
        if (isPresetBound) {
            const sel = await alertConfirmMulti(
                language.promptBindingLabel,
                [
                    language.promptBindChange,
                    { label: language.promptBindUnbind, variant: 'destructive' },
                ]
            )
            if (sel === 0) {
                presetSelectCallback.set(bindPreset)
                openPresetList.set(true)
            } else if (sel === 1) {
                unbindPreset()
            }
        } else {
            const sel = parseInt(await alertSelect([
                language.promptBindCurrent,
                language.presetSelectOther,
                language.cancel
            ]))
            if (sel === 0) {
                bindPreset(DBState.db.botPresetsId)
            } else if (sel === 1) {
                presetSelectCallback.set(bindPreset)
                openPresetList.set(true)
            }
        }
    }
</script>

<div class="text-[11px] text-textcolor2 mt-4 px-1">{language.promptBindingLabel}</div>
<div class="flex gap-1 mt-1 items-stretch">
    <ShButton
        className={`flex-1 min-w-0 justify-start ${isPresetBound
            ? 'border-selected text-textcolor'
            : 'text-textcolor2 opacity-50 hover:opacity-100'}`}
        onclick={handlePresetBindClick}
    >
        {#if isPresetBound}
            <PinIcon size={16} class="shrink-0" />
        {:else}
            <PinOffIcon size={16} class="shrink-0" />
        {/if}
        <span class="truncate">{displayPreset?.name ?? language.none}</span>
    </ShButton>
</div>
