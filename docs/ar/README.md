> تتبع هذه الترجمة [النص الأصلي بالإنجليزية](../../README.md). النص الإنجليزي هو المرجع المعتمد؛ الأوامر والخيارات وعناوين URL والعناصر النائبة تبقى بالإنجليزية دون تغيير.

<img src="../../brand/obsync-icon-256.png" alt="أيقونة obsync: حلقتان متشابكتان" width="96" height="96">

# Self Hosted Private Sync

مزامنة حيّة مستضافة ذاتيًا ومشفّرة من طرف إلى طرف لتطبيق [Obsidian](https://obsidian.md). تُزامَن ملاحظاتك عبر خادم تشغّله بنفسك. تُشفَّر الملاحظات والمرفقات وأسماء الملفات على جهازك، ولا يتلقى الخادم المفتاح أبدًا. تعمل الإضافة على كل منصة يعمل عليها Obsidian، على الحاسوب والهاتف. لا اشتراك، ولا حساب في أي مكان آخر.

**هل هناك ما لا يعمل؟ ← [استكشاف الأخطاء](https://snaraj.github.io/obsync/troubleshooting/)**

## اعثر على ما تحتاجه

كل صفحة موجودة أيضًا على [موقع التوثيق](https://snaraj.github.io/obsync/). الصفحات المرتبطة هنا باللغة الإنجليزية.

### استخدام obsync

| أريد أن… | اذهب إلى |
| --- | --- |
| أختار كيف تصل أجهزتي إلى خادمي | [اختر طريقة الإعداد](../setup.md) |
| أُعدّ كل شيء على شبكتي المنزلية، مع كل شاشة على الهاتف | [الشبكة نفسها، خطوة بخطوة](../same-network.md) |
| أثبّت الإضافة | [تثبيت الإضافة](../community-plugin.md) |
| أُعدّ جهازي الأول | [البدء السريع](../quickstart.md) |
| أقرن هاتفًا أو حاسوبًا آخر | [اقرن هاتفك](../quickstart.md#pair-your-phone) |
| أعرف معنى أيقونة الحالة والأوامر | [الاستخدام اليومي](../daily-use.md) و[قراءة شريط الحالة](../troubleshooting.md#reading-the-status-bar) |
| أستعيد نسخة أقدم من ملاحظة | [استعادة نسخة محفوظة](../daily-use.md#restore-a-retained-version) |
| أعرف ما يفعله إعداد ما | [الإعدادات](../settings.md) |
| أتعامل مع نسخة تعارض | [التعارضات](../conflicts.md) |
| أصلح مشكلة | [استكشاف الأخطاء](../troubleshooting.md) |
| أستعيد الوصول بعد فقدان جهاز | [الاسترداد](../recovery.md) |
| أنقل خزنتي إلى خادم آخر | [نقل هذه الخزنة إلى خادم آخر](../recovery.md#moving-this-vault-to-a-different-server) |

### تشغيل خادم

| أريد أن… | اذهب إلى |
| --- | --- |
| أشغّل خادمي بـ Docker أو Compose | [تشغيل الخادم](../server.md) |
| أضعه خلف وكيلي الخاص (Caddy، nginx، Traefik، HAProxy) | [لديك مُنهي TLS بالفعل](../server.md#already-have-a-tls-terminator-docker) |
| أشغّله بلا حاوية، تحت systemd | [الملف التنفيذي الثابت](../server.md#without-a-container-the-static-binary) |
| أشغّل خادمي على Kubernetes | [Kubernetes](../kubernetes.md) و[مرجع المخطط](../../chart/README.md) |
| أصل إلى خادمي خارج المنزل، عبر VPN أو وكيل خاص بي | [الوصول إليه من خارج شبكتك المحلية](../server.md#reaching-it-from-outside-your-lan) |
| أستخدم Cloudflare (اختياري) | [Cloudflare](cloudflare.md) |
| أثق بشهادة خادمي على كل جهاز | [الثقة بسلطة الشهادات](../server.md#trust-the-certificate-authority-once-per-device) |
| أعرف كم يحتاج من الذاكرة ومساحة القرص | [كم يحتاج من الذاكرة](../server.md#how-much-memory-it-needs) و[التخزين](../storage.md) |
| أنسخ خادمي احتياطيًا | [النسخ الاحتياطي لوحدتي التخزين](../server.md#back-up-the-two-volumes) |
| أحدّث خادمي | [التحديث بالبصمة](../server.md#upgrade-by-digest) |
| أرى أجهزتي وألغي أحدها | [لوحة التحكم](../dashboard.md) |
| أمسح خادمي وأبدأ من جديد | [مسح الخادم بالكامل](../purge.md) |
| أرى ما الذي تغيّر في كل إصدار | [`CHANGELOG.md`](../../CHANGELOG.md) |

### الثقة والخصوصية

| أريد أن… | اذهب إلى |
| --- | --- |
| أعرف ما الذي تصل إليه هذه الإضافة على جهازي وشبكتي | [ما الذي تصل إليه هذه الإضافة](#ما-الذي-تصل-إليه-هذه-الإضافة) |
| أفهم ما الذي يُشفَّر وما يستطيع الخادم رؤيته | [نموذج التهديد](../threat-model.md) و[نموذج التهديد الخاص بلوحة التحكم](../security/dashboard.md) |
| أبلّغ عن مشكلة أمنية | [`SECURITY.md`](../../SECURITY.md) |

### داخل المشروع

للمساهمين والمراجعين: [`CONTRIBUTING.md`](../../CONTRIBUTING.md)، و[البنية](../architecture.md)، و[البروتوكول](../protocol.md)، و[قياسات الأداء](../benchmarks.md)، و[تشغيلات التحقق على الأجهزة](../validation-runs/)، و[كل الصفحات](../README.md).

## التثبيت

![إعدادات الإضافة تُفتح على Get started: صف Setup guide وزرّه Open the guide، فوق حقل Server URL](../assets/settings-get-started.png)

ثبّت الإضافة من **الإعدادات ← إضافات تابعة لجهات خارجية ← تصفّح**. ابحث عن **Self Hosted Private Sync** (معرّف الإضافة `obsync-private-sync`). تحتاج إلى Obsidian 1.13.0 أو أحدث. تُفتح إعداداتها على دليل الإعداد، على بُعد نقرة واحدة.

> [!IMPORTANT]
> - تُزامن مع خادم تشغّله **أنت**: لا خدمة مستضافة، ولا حساب عند أحد سواك.
> - انسخ خزنتك احتياطيًا أولًا، واحتفظ بعبارة الاسترداد المكوّنة من 24 كلمة بعيدًا عن الجهاز الذي ولّدها.
> - لا تشغّلها أبدًا إلى جانب مزامنة أخرى (Obsidian Sync، أو مجلد سحابي، أو إضافة أخرى) على خزنة واحدة.
> - برمجية حديثة العهد: اقرأ مدخلة [`CHANGELOG.md`](../../CHANGELOG.md) الخاصة بإصدارك، وحدّث كل جهاز، واعرف ما الذي غطّاه كل [تشغيل تحقق](../validation-runs/).

## ابدأ المزامنة

أقصر مسار كامل هو Compose مع Caddy على شبكتك أنت، من نسخة مسحوبة من هذا المستودع. يمنحك HTTPS على أي شبكة، بلا نطاق وبلا حساب في أي مكان. تشرح صفحة [الشبكة نفسها، خطوة بخطوة](../same-network.md) هذا المسار مع كل شاشة. استبدل `vX.Y.Z` أدناه بالإصدار الذي تثبّته، وهو أحدث وسم في [صفحة Releases](https://github.com/snaraj/obsync/releases/latest).

**1. تحقّق من الصورة.** ثم شغّل البصمة التي طبعها الأمر بالضبط:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. شغّل الخادم:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` هو الاسم الذي ستكتبه أجهزتك، ويكفي أن يُحلّ داخل شبكتك أنت. و`OBSYNC_BIND_ADDRESS` هو العنوان الذي يُنشر عليه المنفذان 80 و443: عنوان الربط يقيّد واجهة الوجهة لا المصدر، فجدارك الناري هو ما يقرّر من يصل إليه. ويرفض Compose أن يبدأ حتى تختار.

**3. اقرأ رمز الإعداد.** عند أول إقلاع يولّد الخادم رمز إعداد ويكتبه إلى وحدة تخزين السجل الخاصة به، بالوضع 0600، ولا يُسجَّل أبدًا. ينشئ حسابك مرة واحدة، ثم يبقى تسجيلَ الدخول الاستردادي للوحة التحكم. احفظه بالعناية نفسها التي تحفظ بها عبارة الاسترداد:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. أعدّ كل جهاز.** ثق بشهادة الخادم مرة واحدة ([كيف](../server.md#trust-the-certificate-authority-once-per-device)). ثبّت الإضافة، ثم اتبع [البدء السريع](../quickstart.md): أعدّ الجهاز الأول، ثم اقرن الأجهزة الأخرى.

ألديك HTTPS بالفعل في المقدمة، من وكيل أو نفق تثق به؟ شغّل [الخادم المجرّد](../server.md#already-have-a-tls-terminator-docker) بدلًا من ذلك.

## ما الذي تصل إليه هذه الإضافة

- **خادمك أنت، لا شيء غيره.** يذهب كل طلب إلى **Server URL** الذي تكتبه؛ لا قياسات عن بُعد، ولا طرف ثالث.
- **حساب على ذلك الخادم**، يُنشأ من رمز الإعداد؛ وحسابك في Obsidian لا دور له هنا.
- **صفحات GitHub Releases، عبر Obsidian**، للتثبيت والتحديث؛ ويتجاهل Obsidian ملفات الإصدار الإضافية.
- **قائمة ملفات خزنتك**، لتقرّر ما الذي يُزامَن؛ وتُتخطّى المجلدات المخفية (`.obsidian` و`.git`) والمرتبطة رمزيًا.
- **الحافظة، يُكتب فيها فقط** عبر **Copy code** و**Copy link** في **Pair a new device**، ولا تُقرأ أبدًا.
- **متصفحك، حين تطلب دليل الإعداد.** يُفتح فيه دليل المشروع؛ والإضافة نفسها لا ترسل شيئًا.

ما يستطيع الخادم رؤيته وما لا يستطيع: [`SECURITY.md`](../../SECURITY.md) و[نموذج التهديد](../threat-model.md).

## الإصدارات

إصدار LATEST هو أحدث وسم في [صفحة Releases](https://github.com/snaraj/obsync/releases/latest)، وهو ما يثبّته Obsidian ويحدّث إليه. أما `main` فهو EDGE: عمل مدموج لم يُصدَر بعد، لمن يبني من المصدر. لا توجد قناة تجريبية ولا وسم إصدار تمهيدي. وقسم «Unreleased» في سجل التغييرات يدوّن ما في EDGE.

## الأسئلة والأخطاء والأمن

- **سؤال، أو شيء لست متأكدًا من كونه خطأً برمجيًا:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **خطأ برمجي:** [افتح مشكلة](https://github.com/snaraj/obsync/issues/new/choose) ومعها التقرير الذي يصفه [استكشاف الأخطاء](../troubleshooting.md#how-to-collect-a-report). لا تُدرج فيه أي رمز أو عبارة أو عنوان ما كنت لتنشره.
- **ثغرة مشتبه بها:** بسرّية، عبر [`SECURITY.md`](../../SECURITY.md)، ولا عبر مشكلة عامة أبدًا.

## الرخصة

MIT. انظر [`LICENSE`](../../LICENSE).
