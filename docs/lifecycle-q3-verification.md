# Q3 yaşam döngüsü doğrulaması

2026-09-08; uygulama commit’i afc2d8b. Önceki WIP commit’leri korunmuştur.

- F1: iki sağlayıcı registry’si kapanır; retire edilmiş işler dahil run done ve süreç temizliği beklenir. Dört sahte çocuk için live/çocuk/ev 4/4/4 → 0/0/0.
- F2: silinemeyen config home kept sayılır; dispose tekrar denenebilir; gerçek Windows dosya kilidi ve retry kolları geçer.
- F3: park edilmiş tool çağrıları kapasite için tahliye edilmez; tavanda 503 döner. Terk edilmiş park, idle timeout’a (varsayılan 30 dakika) veya sağlayıcının zaman aşımına kadar kapasite tutar.
- F4: normal alt süreçte gerçek registry router.log park olayı üretir; node:test bağlamı dosyaya yazmaz.
- A2.2: MCP route iki gerçek registry ile launcher’ın üretim fallback’ini kullanır; secondary hit ve iki miss ölçülür.

11/11 mutasyon, tam npm run test takımında beklenen kolu düşürdü. Her mutasyonda kaynak Buffer bellekte tutuldu, finally ile geri yazıldı; kaynak ve 101 dosyalık ağaç SHA-256 değerleri önce/sonra eşitti. Mutasyonlardan sonraki fixture yarışı düzeltmesi ve girinti değişikliği için son kaynak ayrıca kontrol edildi.

npm run check: exit 0; 427 test / 426 pass / 0 fail / 1 skip; 83 suite; 34.845 saniye test süresi. Lint ve TypeScript geçti. Sır taraması 100 dosya / 12 kural / 0 bulgu; kanarya ve kabul/red özdenetimleri geçti.

NOT_RUN: kurulu patched shadow kabul kolu eski yerel patch nedeniyle skip; canlı Google/Grok OAuth çağrıları, gerçek zamanlı 30 dakika park bekleyişi, Windows dışı kilit ölçüsü ve ek coverage. Bağımsız kod incelemesi: 0 açık bulgu.

Tam mutasyon tablosu, loglar ve bağımsız inceleme operatörün mevcut astra-q3-uygulama.md raporunda ve kardeş astra-evidence/q3 dizinindedir.
