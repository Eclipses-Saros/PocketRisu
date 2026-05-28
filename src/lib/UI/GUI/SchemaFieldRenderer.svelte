<script lang="ts">
    import type { RegistryFieldSchema, RegistryUiField } from "src/ts/preset/types";
    import TextInput from "./TextInput.svelte";
    import TextAreaInput from "./TextAreaInput.svelte";
    import NumberInput from "./NumberInput.svelte";
    import SliderInput from "./SliderInput.svelte";
    import SelectInput from "./SelectInput.svelte";
    import OptionInput from "./OptionInput.svelte";
    import CheckInput from "./CheckInput.svelte";

    interface Props {
        schemaField: RegistryFieldSchema;
        uiField: RegistryUiField;
        userValues: Record<string, unknown>;
    }

    let { schemaField, uiField, userValues = $bindable() }: Props = $props();

    const fieldKey = $derived(schemaField.key);

    // stringArray widget: textarea one-per-line, syncs to/from userValues[key]: string[]
    let stringArrayText = $state('');
    let stringArrayInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (stringArrayInitialized) return;
        const v = userValues[fieldKey];
        stringArrayText = Array.isArray(v) ? v.join('\n') : '';
        stringArrayInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'string-array') return;
        if (!stringArrayInitialized) return;
        const lines = stringArrayText.split('\n').map(s => s.trim()).filter(Boolean);
        userValues[fieldKey] = lines.length === 0 ? undefined : lines;
    });

    // JSON widget: stringify on read, parse on write. Errors surface inline.
    // We seed jsonText from userValues once on mount, then user edits jsonText
    // and an $effect parses+commits on every change (invalid JSON keeps the
    // last good value but shows the error).
    let jsonText = $state('');
    let jsonError = $state<string | null>(null);
    let jsonInitialized = $state(false);

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (jsonInitialized) return;
        const v = userValues[fieldKey];
        try {
            jsonText = v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
        } catch {
            jsonText = '';
        }
        jsonInitialized = true;
    });

    $effect(() => {
        if (uiField.widget !== 'json' && uiField.widget !== 'key-value') return;
        if (!jsonInitialized) return;
        if (jsonText.trim() === '') {
            userValues[fieldKey] = undefined;
            jsonError = null;
            return;
        }
        try {
            userValues[fieldKey] = JSON.parse(jsonText);
            jsonError = null;
        } catch (e) {
            jsonError = e instanceof Error ? e.message : String(e);
        }
    });
</script>

<div class="flex flex-col gap-1">
    <span class="text-sm text-textcolor flex items-center gap-1">
        {schemaField.label}
        {#if schemaField.required}<span class="text-red-400">*</span>{/if}
    </span>
    {#if schemaField.description}
        <span class="text-xs text-textcolor2">{schemaField.description}</span>
    {/if}

    {#if uiField.widget === 'text'}
        <TextInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
        />
    {:else if uiField.widget === 'secret'}
        <TextInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
            hideText
        />
    {:else if uiField.widget === 'textarea'}
        <TextAreaInput
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            fullwidth
            autocomplete="off"
            height="24"
        />
    {:else if uiField.widget === 'number-input'}
        <NumberInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min}
            max={schemaField.max}
            fullwidth
        />
    {:else if uiField.widget === 'slider'}
        <SliderInput
            bind:value={userValues[fieldKey] as number}
            min={schemaField.min ?? 0}
            max={schemaField.max ?? 100}
            step={schemaField.step ?? 1}
        />
    {:else if uiField.widget === 'select'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each schemaField.enum ?? [] as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'segmented'}
        <SelectInput bind:value={userValues[fieldKey] as string}>
            {#each schemaField.enum ?? [] as opt}
                <OptionInput value={String(opt.value)}>{opt.label}</OptionInput>
            {/each}
        </SelectInput>
    {:else if uiField.widget === 'toggle'}
        <CheckInput bind:check={userValues[fieldKey] as boolean} name={schemaField.label} />
    {:else if uiField.widget === 'combobox'}
        <input
            type="text"
            class="bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-textcolor focus:outline-hidden focus:ring-2 focus:ring-borderc"
            bind:value={userValues[fieldKey] as string}
            placeholder={uiField.placeholder ?? ''}
            list={`combobox-${fieldKey}`}
        />
        <datalist id={`combobox-${fieldKey}`}>
            {#each schemaField.enum ?? [] as opt}
                <option value={String(opt.value)}>{opt.label}</option>
            {/each}
        </datalist>
    {:else if uiField.widget === 'string-array'}
        <TextAreaInput
            bind:value={stringArrayText}
            placeholder={uiField.placeholder ?? '한 줄에 하나씩'}
            fullwidth
            autocomplete="off"
            height="20"
        />
    {:else if uiField.widget === 'json' || uiField.widget === 'key-value'}
        <TextAreaInput
            bind:value={jsonText}
            placeholder={uiField.placeholder ?? '{}'}
            fullwidth
            autocomplete="off"
            height="32"
        />
        {#if jsonError}
            <span class="text-xs text-red-400">{jsonError}</span>
        {/if}
    {/if}
</div>
