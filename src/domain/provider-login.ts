export type DeviceLoginProvider = "openai" | "xai";
export interface DeviceLoginPlan {
    readonly interaction: "device_code";
    readonly arguments: readonly string[];
    readonly notice: string;
}
const plans: Readonly<Record<DeviceLoginProvider, DeviceLoginPlan>> = {
    openai: {
        interaction: "device_code",
        arguments: ["providers", "auth", "openai"],
        notice: "OpenAI OAuth device login: keep this terminal visible. Copy the short code shown below into the browser page. The CLI will detect completion automatically.",
    },
    xai: {
        interaction: "device_code",
        arguments: ["login", "--device-auth"],
        notice: "xAI OAuth device login: keep this terminal visible. Copy the short code shown below into the browser page. Do not paste a browser result back into the terminal.",
    },
};
export function deviceLoginPlan(provider: DeviceLoginProvider): DeviceLoginPlan {
    return plans[provider];
}
