<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';

    interface Props {
        field: 'textScreenColor' | 'textScreenBorder';
        labelKey: 'textBackgrounds' | 'textScreenBorder';
        defaultColor: string;
        helpKey?: 'textScreenColor' | 'textScreenBorder';
    }

    let { field, labelKey, defaultColor, helpKey }: Props = $props();
    let currentValue = $derived(DBState.db[field]);
    const helpText = $derived(helpKey ? (language.help as any)[helpKey] : undefined);
</script>

<div class="flex items-center justify-between gap-3 py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language[labelKey]}</span>
        {#if helpText}<p class="text-xs text-textcolor2 mt-0.5">{helpText}</p>{/if}
    </div>
    <div class="shrink-0 flex items-center gap-2">
        {#if currentValue}
            <input
                type="color"
                class="h-8 w-10 rounded border border-darkborderc bg-transparent cursor-pointer"
                value={currentValue}
                oninput={(e) => {
                    DBState.db[field] = e.currentTarget.value;
                }}
            />
        {/if}
        <ShSwitch
            checked={!!currentValue}
            onCheckedChange={(v) => {
                DBState.db[field] = v ? defaultColor : null;
            }}
        />
    </div>
</div>
