import { getDatabase, getCurrentChat } from "src/ts/storage/database.svelte";

export function getGenerationModelString(name?:string){
    const db = getDatabase()
    // Binding-aware default label: when no explicit model name is passed (the
    // primary generation), reflect the bound ModelPreset instead of the classic
    // db.aiModel. Only applies in the binding regime; classic chats fall through.
    if(name === undefined){
        const chat = getCurrentChat()
        const boundMainId = chat?.useModelPreset ? chat.modelBinding?.main : undefined
        if(boundMainId){
            const preset = db.modelPresets?.find(p => p.id === boundMainId)
            if(preset) return preset.name
        }
    }
    switch (name ?? db.aiModel){
        case 'reverse_proxy':
            return 'custom-' + (db.reverseProxyOobaMode ? 'ooba' : db.customProxyRequestModel)
        case 'openrouter':
            return 'openrouter-' + db.openrouterRequestModel
        case 'nanogpt': {
            const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel
            return 'NanoGPT ' + modelLabel + (db.nanogptUseSubscriptionEndpoint ? ' [SUB]' : '')
        }
        default:
            return name ?? db.aiModel
    }
}