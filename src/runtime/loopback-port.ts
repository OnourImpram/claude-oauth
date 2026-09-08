import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
export async function allocateLoopbackPort(): Promise<number> {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.close();
    await once(server, "close");
    return port;
}
// Claude Code'un ag gecidi model kesfi, onbellegini ANTHROPIC_BASE_URL'e BIREBIR
// anahtarlar (binary'de: `e.baseUrl !== a.ANTHROPIC_BASE_URL -> return []`). Her
// oturumda efemeral bir port o onbellegi her defasinda gecersiz kilar ve /model
// listesi harici modelleri HIC gostermez. Bu yuzden port sabittir.
//
// Loopback'te sabit bir port tahmin edilebilirdir, ama tek basina bir sey acmaz:
// her istek 256-bit oturum nonce'unu (baslik ya da yol) tasimak zorunda, aksi
// halde 401 doner.
// 8787 BILEREK KULLANILMIYOR: bu makinede ~/.claude/cache/gateway-models.json
// hala 2026-05-05 tarihli, baseUrl'i http://127.0.0.1:8787 olan ve artik
// var olmayan bir ag gecidinin dort modelini tasiyor. O portu secmek, bizim
// sunmadigimiz hayalet modelleri picker'a dusururdu.
export const PINNED_LOOPBACK_PORT = 8791;
export function preferredLoopbackPort(environment: NodeJS.ProcessEnv = process.env): number {
    const raw = environment["HEZARFEN_ROUTER_PORT"];
    if (raw === undefined)
        return PINNED_LOOPBACK_PORT;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : PINNED_LOOPBACK_PORT;
}
