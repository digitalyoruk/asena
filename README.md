This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, install dependencies and run the development server:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Asena canlı demo (`/demo`)

Demo ekranı tarayıcıda çalışır; veri (müşteri, kurye, randevu, SMS) tarayıcının `localStorage`'ında tutulur. Web uygulaması için **env gerekmez**. Vercel linki **kurulumsuz da çalışır**: motor yoksa kararlar kural + şablon cümlelerle verilir, sesler Chrome'un Türkçe sesiyle çalar. Motor (repodaki `engine/`) çalışırsa gerçek modeller devreye girer. Sesler (EMA Lightning, Antalia-2 Mini) ve model (Kumru-2B, Ollama) yalnız Mac'te çalışan **yerel motordan** gelir (`127.0.0.1:8787`).

### Lokal
```bash
pnpm install && pnpm dev                                   # http://localhost:3000/demo
cd engine && uv sync && uv run asena-engine                 # yerel motor (ilk seferde uv sync)
```
Motorun terminale bastığı `http://localhost:3000/eslestir#t=…` bağlantısını açın.

### Vercel (canlı adres)
1. Repoyu Vercel'e bağlayıp build alın (env yok).
2. Mac'te motoru canlı adrese izin vererek başlatın:
   ```bash
   cd ~/Projects/asena/engine && ASENA_ALLOWED_ORIGINS=http://localhost:3000,https://<site>.vercel.app uv run asena-engine
   ```
3. `https://<site>.vercel.app/demo`'yu **Chrome**'da açın. Motor bağlı değilse sayfa bu komutları sitenin adresiyle hazır gösterir.
4. Eşleştirme: terminaldeki `https://<site>.vercel.app/eslestir#t=…` bağlantısını açın **ya da** `cat ~/.asena/token | pbcopy` ile token'ı kopyalayıp sayfadaki kutuya yapıştırın.
5. Chrome "yerel cihazlara erişim" izni sorarsa **İzin ver**. Reddedildiyse: site ayarları → Yerel ağ erişimi → İzin ver.

Not: localhost ile canlı adres farklı origin'dir; eşleştirme ve demo verisi her adreste ayrı tutulur.
