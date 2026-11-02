# travel-mobility 复核：移出条目与理由

生成时间：2026-11-02。数据来源：`data/catalog/site-snapshot/categories/use-cases/travel-mobility.json`（2026-11-01 快照，1,121 条）与本地模型复核（`enrich-travel.js --run`，596 条）。

**结果**：1121 → 863 条；移出 258 条。规则类 50 条（视频模板名 42、time-travel 2、偶发提及 1、复核失败且规则也不认 5）；模型按目标业务场景改判 208 条。机器可读版本见 `travel-mobility-overlay.json` 的 `drops`，构建时按标题/摘要指纹生效。

## 分组计数

| 理由 | 条数 |
|---|---|
| `llm:lifestyle-entertainment` | 89 |
| `video-template-name` | 42 |
| `llm:business-growth` | 36 |
| `llm:content-creation` | 23 |
| `llm:research-learning` | 22 |
| `llm:desktop-productivity` | 18 |
| `review-failed:no-result` | 5 |
| `llm:software-development` | 4 |
| `llm:data-operations` | 3 |
| `llm:security-testing` | 3 |
| `engineering-phrase:time-travel` | 2 |
| `incidental-phrase` | 1 |
| `llm:content-creation+business-growth` | 1 |
| `llm:desktop-productivity+business-growth` | 1 |
| `llm:content-creation+data-operations` | 1 |
| `llm:research-learning+data-operations` | 1 |
| `llm:research-learning+lifestyle-entertainment` | 1 |
| `llm:lifestyle-entertainment+research-learning` | 1 |
| `llm:content-creation+lifestyle-entertainment` | 1 |
| `llm:business-growth+data-operations` | 1 |
| `llm:software-development+security-testing` | 1 |
| `llm:research-learning+software-development` | 1 |

## 明细

### llm:lifestyle-entertainment（89）

- Win $480 to Spend Your Way Free Giveaway — producthunt — `prd_653175ec6041fe3a316bcfd3`
- [开源自荐] Muralume：轻巧精致的 Mac 视频播放器与动态桌面 — weekly-issues — `prd_fe0622ed7a65659812eafd5f`
- Skip FM — producthunt — `prd_ef7331c0a099ae18d9d7b512`
- PingDial: Smart Dialer — producthunt — `prd_df8780a51de79eb0131ee9ab`
- Free Jigsaw Puzzle Creator: Any Photo — producthunt — `prd_f8eeb5996c32f42093c4ea19`
- Win $900 to Spend Your Way: Free 7 — producthunt — `prd_1c7de8a79648f285d098800b`
- Win $450 to Spend Anywhere Free Giveaway — producthunt — `prd_68c12508dfee4b484c18e4bd`
- CarbonTracker — producthunt — `prd_a94717e2b09078e5d4837947`
- TailSpotter — producthunt — `prd_256ae672f136352897d7bd91`
- resaw: Organize Saved Posts — producthunt — `prd_49ba4be7d2f8e5ebb5451415`
- DaliCircle — producthunt — `prd_82e3720144e1b2ccab3ac3df`
- TuFit — producthunt — `prd_d7f46fd90ba089c970138357`
- 飞飞掼蛋 — vibecafe — `prd_df2e6e2cfd71094656079961`
- Win $350 to Spend Anywhere Free Giveaway — producthunt — `prd_5b10a2d1b2ff46888e81fb99`
- Win $500 to Spend Anywhere Free Giveaway — producthunt — `prd_2cdabb785a89de6c1897f626`
- Dog Hostel in Bangalore — producthunt — `prd_dc3e62c8a3d24be32f7a65a5`
- Business Empire — producthunt — `prd_360838956d2750427e9d7707`
- Win $400 to Spend Anywhere Free Giveaway — producthunt — `prd_a69bace99ae40058fd120954`
- SettleG — producthunt — `prd_d3c986da54bd41989c17ec37`
- Merakk — producthunt — `prd_da7e090354b6359c4a0fb429`
- Allworld — producthunt — `prd_d03916b0b643bd326c546e82`
- GlobeNow.tv — producthunt — `prd_5fec7600bce7419d66b55ad9`
- Wingman Airwave — producthunt — `prd_a351f72aacd39e6b2656c278`
- Win $700 to Spend Anywhere Free Giveaway — producthunt — `prd_dc7b042f51503b89df8e74a7`
- Confessit.lol — producthunt — `prd_e528ef854688eaae0a3a2922`
- Weather Forecast - Live Weather — producthunt — `prd_3d70a12b251571fa42130d60`
- DLNA 镜流 V1.1 电脑通过 DLNA 投屏 — v2ex — `prd_5d347a806497af7d40dd7d8a`
- ToolGrid AI — producthunt — `prd_ac0daed615aaf96755350e09`
- Born in Japan — producthunt — `prd_04b36f787d5b2205405210f4`
- Matcha Portion Cup — producthunt — `prd_4e66ca58a73783eaae27c6d4`
- Midnight Jukebox — producthunt — `prd_6f9c73bd737ffabdc739a7bc`
- MindTheClub — producthunt — `prd_7e27a81a5a114b8f85eb574f`
- Trassa VPN — producthunt — `prd_a55089150ad45f4dfa0540c2`
- 【自荐】花花记账：越记越懂你的 iPhone 生活账本 — weekly-issues — `prd_00150d4b30f5bbd5f2fe8504`
- AquaFlux — producthunt — `prd_67eb8eadb3a0fb7f7ac5248c`
- DineMidway — producthunt — `prd_97e872c11a07bfe8f3cd5776`
- WedLoop — producthunt — `prd_074183be45346c441332204a`
- Youtubers Map — producthunt — `prd_212f93f7da2ca2689f812354`
- Agents4 Fitness — producthunt — `prd_30fee9c63df1ca8f61a1f91a`
- Hoping to Find Someone Who Shares My — producthunt — `prd_0016cd529ae8696b01d76485`
- Merakk — producthunt — `prd_1823d66f3ede338ad61c9eca`
- Duo Cards: Crazy 8s & Mau Mau — producthunt — `prd_ed32bae0a22f5e1e2f620742`
- Merakk — producthunt — `prd_a8ce77571f40cf8f4f2e5d59`
- Merakk — producthunt — `prd_7a2ffdee104c720645e621ab`
- Merakk — producthunt — `prd_be3b07f34aa1ec313f37529a`
- U OK? — producthunt — `prd_25e129c4529595f672a84298`
- Grasp — producthunt — `prd_306599f1581d2cd7b189cb1e`
- Streakly — producthunt — `prd_a64ddbbb1555cca07297e700`
- USB Blenders For Everyday Use. — producthunt — `prd_586585c499f29a8353e22ae7`
- Agra News, Latest Updates, Agra Trends — producthunt — `prd_ed91b9551703a2f587090ce6`
- Show HN: Wet Bulb Tracker Tracker – sends you humid-heat alerts and forecasts — showhn — `prd_7e3e53a3bc3b87356d921ff4`
- Arcadia — producthunt — `prd_4bb890b5b05a5c72a66cb943`
- PERSONALISED BACKPACKS — producthunt — `prd_e54380bb8c557e8b6a2b99fd`
- LiveWorld — producthunt — `prd_448ca66ac16598cb12631166`
- Bien.uy — producthunt — `prd_7be7bb1364b6527245422b14`
- KeepFamilySafe Family Safety — producthunt — `prd_49feffe9b2c487ca60ad1266`
- Car Check Report — producthunt — `prd_685d800015db691f71bed4c0`
- 学历、英语、存款、工作经验：你离新加坡到底还有多远？ — v2ex — `prd_8abea225a22e32c2d0881e77`
- BubbleSpots — producthunt — `prd_e004055f7a0b18c95b5e1ee9`
- Wanderly Escape Card — producthunt — `prd_f5d0390a754a31c52456a308`
- Show HN: LiveWorld – Every 24/7 YouTube live camera on one globe — showhn — `prd_11b6e0165d8862476f682e98`
- Tokyo Yamathon 2026 — producthunt — `prd_133c7a72368b94c52df55483`
- Telvio — producthunt — `prd_5aea27e19c25ac91b06d7fd6`
- KarmAI — producthunt — `prd_73cc3ed9680b30970b2362f6`
- HomeBase Advocate — producthunt — `prd_aced50cafa0928e765e86ff8`
- CarAI — producthunt — `prd_b8f4083de71c112ba6a90bc4`
- MoverMath — producthunt — `prd_809f4e4b3ee7703c0a9f6458`
- cMe — producthunt — `prd_b508db829742154c792e3425`
- WanderHue — producthunt — `prd_bed9c7783b418533f989d86b`
- BSCOBBER OmniPump-1 — producthunt — `prd_0ba44ecf465d32b6fedc8e75`
- Oil & Miles — producthunt — `prd_1412d282c80e0a1598333c22`
- Polaris — producthunt — `prd_19583b9677e2abe7078952bc`
- MyMotor — producthunt — `prd_7f0a637e0d36466b69fc4e6a`
- ConnecTMee — producthunt — `prd_994931b51af708152493dd13`
- Windy Gap — producthunt — `prd_a17f2feff4ad9fd717927379`
- Dashoo — producthunt — `prd_cdb1498b584c33fd163ac11c`
- SafeWalk Mirror — producthunt — `prd_8776b76c8c76385b815db70b`
- Blinkey Smart Drive — producthunt — `prd_a1811da9436317460314c3bd`
- Alvenea — producthunt — `prd_dceaec369026279712c84642`
- Amperlo — producthunt — `prd_094e74b9fc83cc686cc77f73`
- CineMap 2.0 — producthunt — `prd_5d869d5cdc45ba56bbd451c9`
- EV Car Expert — producthunt — `prd_c66fe1ae174f90f5a1e1e62c`
- Hop Déménagement — producthunt — `prd_34bea42db97339147097ed21`
- Movers & Packers Abu Dhabi — producthunt — `prd_9fd511a923178174c6cd6191`
- Japan Walk Nomad — producthunt — `prd_a8de8e20117299ebc725527f`
- Evaporate — producthunt — `prd_c8ea3ec4d14ae9754186fda7`
- Time Now Live — producthunt — `prd_87023abae615345ee60f0461`
- MaxPoints — producthunt — `prd_8ad2651260117fa5001392c2`
- Zak Mobile Tyres Glasgow — producthunt — `prd_ee5ccd118cbe82f26c27f419`

### video-template-name（42）

- Raindance Maker — producthunt — `prd_2b5760a8a8b37d2f20526840`
- 做了个把照片变成说唱 MV 的小站，咪咪也能来段说唱 😂（送兑换码） — v2ex — `prd_19e17530e57d904bc8c878fe`
- 【工具自荐】Rap Video：基于照片生成双人对唱说唱视频与原创伴奏的 AI 工具 — weekly-issues — `prd_204606fee6359215b65118ac`
- RapGlow — producthunt — `prd_8ab03c3cb35d7511961c4264`
- Kinevello AI Video Generator — producthunt — `prd_b6740e6a7aa2137ef21baa34`
- Blinkpop.video — producthunt — `prd_c5fb569ccda15e7dfb265883`
- ReclipMuse — chinese-indie-dev — `prd_608dfcc6ae77df9e818deca8`
- RapVideo.ai — producthunt — `prd_9688b56868caf72258faa208`
- 最近做了个好玩的 AI Rap Video Generator - rapvideo.io 欢迎大家免费来玩 — v2ex — `prd_023a8e330b3220794041a629`
- Hotel Lobby AI — chinese-indie-dev — `prd_c366a38e3ebc65db2fc66fbb`
- MemeAIVideo — producthunt — `prd_ce2e34338f6aceb4252833a2`
- Spitnova — producthunt — `prd_10bc646ba867ee3181a65e8c`
- Hotel Lobby AI Video — producthunt — `prd_cfaa44893d9a5ee219bd373d`
- aiMakeVideo — chinese-indie-dev — `prd_4f0069b34096492c1fcef23f`
- Picmira — producthunt — `prd_145dc383e5cfe80aa8f9d2f6`
- Hotel Lobby AI — producthunt — `prd_7f4dfd56b9df16b52ed33496`
- 【产品自荐】Hotel Lobby AI：照片生成 Hotel Lobby 主题短视频 — weekly-issues — `prd_dcc99513f3fa532eb0e13485`
- Migos AI — producthunt — `prd_0d9275f1e2649e6a6ce4498d`
- Lucer AI Video — chinese-indie-dev — `prd_7c2e792f1770607e1a7859f9`
- Hotel Lobby AI — chinese-indie-dev — `prd_7d5b2b696e579dc79f033375`
- DUOTAP — producthunt — `prd_c9b8f1e0241dd46d6724517e`
- Show HN: Hotel Lobby AI – 9:16 vertical COLORS show rap videos with Wan 3.0 — showhn — `prd_d08a08daaaebf1c57f0e9f83`
- Hotel Lobby AI Video — producthunt — `prd_08321f48e37333436d15c1ff`
- Trend Remake — producthunt — `prd_08e4ff7a69e839459e560303`
- 【工具自荐】快速生成流行短视频快速(https://clickclips.co) — weekly-issues — `prd_4937a329e04c731da7817323`
- Show HN: OraStage – turn two photos into a Hotel Lobby rap video — showhn — `prd_699ad39a8621bd210cc94ae7`
- Hotel lobby AI video generator — producthunt — `prd_deadbdedce445dda71573541`
- Hotel Lobby AI Video Generator — producthunt — `prd_0d564cbcd8d6dbefabddc635`
- Hotel Lobby AI — producthunt — `prd_888d7fffc5e5bb83777a05c2`
- Hotel Lobby AI — producthunt — `prd_8fa9ff8c2bd09978601be096`
- StagePair — producthunt — `prd_1b67429cf88bc13e5e1e51c7`
- DanseAI — producthunt — `prd_e5e531bce6cfd6db7abe1dc1`
- Hotel Lobby AI — producthunt — `prd_eef0ed1317d6906e29b57826`
- Rap Song — Hotel Lobby Song Generator — producthunt — `prd_f7a493fd7282e1cc788990ac`
- 做了个小工具：两张照片生成 Hotel Lobby 风格的 AI 短视频 — v2ex — `prd_45ec389f325b11a30e440f1f`
- My Hotel Lobby AI — producthunt — `prd_5ca265b972e38b72c84ca6d1`
- Hotel Lobby AI — producthunt — `prd_6175a3a5f3c039f17b7a78c1`
- Hotel Lobby AI — producthunt — `prd_91062623912ab2a673952aa3`
- Hotel Lobby AI Filter — producthunt — `prd_b7d8b5d375aa9b04c6082a36`
- HotelLobby — producthunt — `prd_625639c0e1e2c0683da86b4f`
- Hotel Lobby AI — producthunt — `prd_f982c8ec97d0fb53cd753dc4`
- Show HN: Hotel Lobby AI Video Generator – Two Photos to Rap Duet — showhn — `prd_e2bf8c6c4a702818c7767ff4`

### llm:business-growth（36）

- RoveLogics — producthunt — `prd_85086c016f50d7687b30133e`
- Plurel — producthunt — `prd_f9a9a8a6d047283bea22d2f1`
- Win $1,000 to Spend Your Way: Free — producthunt — `prd_813e6f4dda33bb3f4d2c514d`
- Venus Hotel Management Software — producthunt — `prd_3198a59f27bf14a8d67f2f22`
- PrimeGuest — producthunt — `prd_fc93fc0f5108a4a578f149d8`
- CapMoney — producthunt — `prd_16ed6abb958cc34fefef44e0`
- Win $420 to Spend Anywhere Free Giveaway — producthunt — `prd_7e97996205f2583dfd4aa0e4`
- Verda Cloud｜AI Infra 组内直招 Senior Devops — weekly-issues — `prd_810231effd447d7d300e085c`
- Hoscover — producthunt — `prd_c30c54775803c9feb2478986`
- SMRTROOM — producthunt — `prd_e2993b2217e0293178bc417a`
- 票匣AI · 专属收票邮箱,发票自动归集成报销包 — vibecafe — `prd_54769ec59b7ae622222e184a`
- Lidolovets — producthunt — `prd_384d0ff91823d5777593ae8d`
- VeriSec Labs — producthunt — `prd_3fbfc7dc76476fb80d50268b`
- GoPromotional Travel Mugs — producthunt — `prd_bab526f4e82f2a133fd92418`
- TableFlow — producthunt — `prd_2e9248e9606f98d832d6d671`
- Pugali Digital — producthunt — `prd_42e57a562f6bfc729dc92dcb`
- TravelBoost — producthunt — `prd_86ad832898bcb42c8d9fae41`
- local-point — producthunt — `prd_af775da916335e5e0fd01d4e`
- HospiCore PMS - Hotel Management System — producthunt — `prd_0a94fbd9ece8b44692d23f99`
- PrimeReviews — producthunt — `prd_d2a2c8df7a4816a95b0e40ea`
- Tuscany Bags — producthunt — `prd_423683e7908474c7550764f7`
- Show HN: Collaborative money tracker, E2E encryption, MCP — showhn — `prd_9a29a1b3f4817ff6028e372a`
- TempButton AI — producthunt — `prd_ac89c79bc691cd0dcff9dced`
- ATLAS & INDUS LINEN CO. — producthunt — `prd_9155119ceaa8523c6cb8910b`
- Lodge Deck — producthunt — `prd_e0cbec954619c91038ba75a3`
- B2B AI SOFT — producthunt — `prd_66747d562cf76d029a052d0a`
- Minetra — producthunt — `prd_6ad6b7a69a11e493fd49df7d`
- Infovion — producthunt — `prd_8e4e9430f0ba4db4e36e28bb`
- Hostel Cloud — producthunt — `prd_2ef81d0d5be91fdf60b17c78`
- MerchanSys — producthunt — `prd_5b52d12a4081a4b0e8a373e1`
- Mess Ledger — producthunt — `prd_7a65441f9032086ae6af5474`
- JobCova — Job Decision Platform — producthunt — `prd_7ee2baf68e6da5dee4cf6d6c`
- QuoteSprout — producthunt — `prd_9472fe9263670d56417a7440`
- HotelKolay — producthunt — `prd_5ec9c72b3032c07efd6a72b9`
- tank.cash — producthunt — `prd_3d588118130d88db4e53bb01`
- Trail & Tide Gift Card — producthunt — `prd_73516b6e1b56ca47f993228d`

### llm:content-creation（23）

- Pixshop — producthunt — `prd_903c0cea59e7a9300f542904`
- NEXORA Tools — producthunt — `prd_a54909650776faca09600877`
- Erase Background — producthunt — `prd_962bc06afbb31f8b39b9283b`
- Ultimate Thumbnail Maker — producthunt — `prd_9776a28e1886c8085d95e87c`
- RUST+ GPUI 海量图片管理 — v2ex — `prd_1760d404447266e943bbf525`
- Show HN: I told people I'm a convicted felon after 20 years of hiding it — showhn — `prd_5a033014a12245d113066d48`
- 【网站自荐】Notebook Generator：免费在线生成可打印的笔记本、手帐 PDF — weekly-issues — `prd_5e6010500d925032e264071a`
- MuftTools — producthunt — `prd_60049fb5953291be86aeb609`
- Maktek Photo AI — producthunt — `prd_d0c558545ffdb177464bfc98`
- Slids — producthunt — `prd_f0867c373e1b7f9f0bcaa82b`
- MomentRescue — producthunt — `prd_1735fb94526a249f1e7d5c91`
- Stroemi — producthunt — `prd_7571940432cc7ae2e4c178ab`
- 【工具自荐】打码鸭：给图片和视频中的人脸、车牌、文字自动打码 — weekly-issues — `prd_0ba2c7f46a80f14f4c57a9ff`
- GPS Map Camera: GeoStamp — producthunt — `prd_c838b48b9d013e375708ebd5`
- FreeTools24x7 — producthunt — `prd_f5b6914d3c683f97d0ee2406`
- Dayleaf — producthunt — `prd_32eafb1100e81bc7cb663c13`
- Tools for World — producthunt — `prd_f4efaa5bafe2380631db44a1`
- GreedyArt — producthunt — `prd_7994b5077f5cab2bbe1b4aeb`
- DEMON HAUS — producthunt — `prd_d1ad1a6d410150f477f637a4`
- Introducing Video Editor in Manus 2.0 — producthunt — `prd_a966fda6df870b3147639e0f`
- StampCam Watermark Camera — producthunt — `prd_2c71b0ed190b97a63ab7dcc9`
- TrailMov — producthunt — `prd_abdf28ccea40c85072c87ff5`
- Timeline Visualizer — producthunt — `prd_432adb32229835d6b40015ea`

### llm:research-learning（22）

- MINERVA ERP — producthunt — `prd_bc76bfa66ca4e79d499f8db5`
- FredSpeak - Speak English — producthunt — `prd_7d12da1304ebab859b768c43`
- SayLingo AI - Language Speaking Partner — producthunt — `prd_edc02f748d9b9e27745b51ee`
- PreMed Toolkit — producthunt — `prd_34d8b07d693b14b05d04b952`
- Trove — producthunt — `prd_b077ba4bd4bdb544d4fd56ae`
- ChronoSpeak — producthunt — `prd_cd3473658934d59eb8233fc1`
- LowKey — producthunt — `prd_d4fa041d2d248bc7a634c310`
- Discover Guinea — producthunt — `prd_cbc42d9e98a5a7f15fcedb28`
- Wingmates — producthunt — `prd_a90dfda304d209f6da659c5e`
- Universities Page — producthunt — `prd_d7497c1740f3bec000e9d760`
- LingoRove — producthunt — `prd_fcd18f0716cc5dc2e7ef9598`
- InstiKit School ERP — producthunt — `prd_6ee4aa7f1f72866671efebd4`
- PortuguesePal - Free Portuguese Partner — producthunt — `prd_8f968f10dac44685ab872e73`
- MakesYouFluent AI — producthunt — `prd_4c200c14219c10ecc1ea3f25`
- Show HN: Are interstellar visitors alien probes? — showhn — `prd_d7f76134d84311fdc76da31a`
- Web Rewinder — producthunt — `prd_2f689c27e6f3e6eecc5fda81`
- Ranchi Portal Free Tools — producthunt — `prd_a0f5e31cc275dbaa72b11b64`
- BenchWork — producthunt — `prd_0dabbc7e48b2b59bdab6dbf0`
- v1prep — producthunt — `prd_1aa1ee3f7c8580a210fb1765`
- Vijayawada — producthunt — `prd_a268e5b776ec3cea84fbad90`
- SpeakLoop — producthunt — `prd_35acd8bfcd51d48978b6f07a`
- [开源推荐] Chinese Literature — 四大名著英文检索站 — hellogithub-issues — `prd_e0e6dbb20b0c5e8c346181de`

### llm:desktop-productivity（18）

- FocusTrek — producthunt — `prd_e652a67a54bbc2c0c4e98063`
- Battery Orbit — producthunt — `prd_90c832f473737736d18e46b1`
- Digital Time Machine — producthunt — `prd_3a3e1227af12162f3fcef177`
- Yuki — producthunt — `prd_96e779ae1c53c86d45a681c4`
- ETA Time Blindness — producthunt — `prd_32f87d1358e61d5bc7fc2c4b`
- Calcus — producthunt — `prd_f0bf92a9f70903e8f45fc7bf`
- GmailClass - Gmail Email Classifier — producthunt — `prd_32c8bef1895f62031b084273`
- NanaZip Rev - NanaZip 社区分支，新增主题切换与代码页切换 — v2ex — `prd_ae214d753762f303e28d2c9a`
- ClockPick™ — producthunt — `prd_bc9e644c44d1fc8fcd9bad11`
- Cursor Teleporter 2 — producthunt — `prd_1f5610aae5223d534669c723`
- Show HN: Kitaphone – Call mobile phones and landlines directly from the browser — showhn — `prd_8ee1da2c78489cf8597af3de`
- Focus Hotel — producthunt — `prd_e82e54043cfa65182a3f9f6c`
- Pizazoo for iPhone and iPad — producthunt — `prd_2c1c3128197e59a9487e8df7`
- MyToolkitt — producthunt — `prd_3e274de787c58cca45d6ec97`
- Focus Train — producthunt — `prd_23c785c5c03c30a164125c5e`
- Potato PDF — producthunt — `prd_f066e8aa860658206588b67b`
- Hark — producthunt — `prd_1c3965d722e6fbe1f634e31d`
- FxPeek — producthunt — `prd_f974bd19d0301f6f46d8d71f`

### review-failed:no-result（5）

- Platform Lifts Vancouver — producthunt — `prd_d733aa9ed948d3b22703bb0b`
- Win $800 to Spend Anywhere Free Giveaway — producthunt — `prd_ed5de01e106aadeb3636f25f`
- 【工具自荐】FreeKitHub：浏览器本地把图片压到目标 KB、合并压缩 PDF，文件不上传 — weekly-issues — `prd_a6fadad54ab806a572081515`
- TWS Technology — producthunt — `prd_afe36a593d297af49dc74a02`
- Introsoftsolutions — producthunt — `prd_48e585677acebbed27128d71`

### llm:software-development（4）

- Pilely — producthunt — `prd_ee97a8bd07849069c1c8ee63`
- Show HN: Kuron – A 5-device airline system from one prompt, no code generated — showhn — `prd_bb3c3257406e5f16f70eed58`
- OneClick IT Consultancy — producthunt — `prd_b291d1744668a9fd1db9c4bc`
- Show HN: A calendar tracker for OpenAI's 28-day Codex reset challenge — showhn — `prd_1e1169085d04a94ba0b085f8`

### llm:data-operations（3）

- Show HN: Hashsync – Deduplicate SSH streams against the receiver's files — showhn — `prd_55baa60d22b7ea0150c831ab`
- TagX — producthunt — `prd_59c6c258a10d0a01cd8ca4d0`
- 写了个 Web 文件管理器：跨平台、单文件、Vue3 + Go，像资源管理器一样用 — v2ex — `prd_dd8807510b9b3393367c4bec`

### llm:security-testing（3）

- Tunnelprobe — producthunt — `prd_1b5f87a23e94021715b78898`
- Is This Legit? — producthunt — `prd_f3d29bb40292ca0ef37240bb`
- Hackerrecon Toolkit & Terminal — producthunt — `prd_2de5b335c544487c34aca6e7`

### engineering-phrase:time-travel（2）

- Time Traveler's Receipt — producthunt — `prd_3d86ef690184b46aa24d1397`
- SakuraLiveCams — producthunt — `prd_b6d61cfc19517baeb1044a4d`

### incidental-phrase（1）

- Tour Diary — producthunt — `prd_9fc64230d7c2171284145d06`

### llm:content-creation+business-growth（1）

- GPS Map Camera: Geotag & Stamp — producthunt — `prd_e9b22e0db03b86cbbba8e808`

### llm:desktop-productivity+business-growth（1）

- NovaRadix Technology — producthunt — `prd_65defa9325368fb3ba0fa25e`

### llm:content-creation+data-operations（1）

- 【自荐】Paxa：泰语、英语、中文语音合成 API，附泰文票据 OCR 和中译泰 — weekly-issues — `prd_8509997bd592436a61a0b802`

### llm:research-learning+data-operations（1）

- OSIRIS — producthunt — `prd_561d2ec5ff613032619c0a65`

### llm:research-learning+lifestyle-entertainment（1）

- Curiworld — producthunt — `prd_bcb009262d7ab91d7ddcfd49`

### llm:lifestyle-entertainment+research-learning（1）

- 【工具推荐】VoiceBridge：YouTube 外语视频翻译配音与双语字幕对照 — weekly-issues — `prd_eb512406ef98ac445ab7e53d`

### llm:content-creation+lifestyle-entertainment（1）

- Sticta — producthunt — `prd_79478dae52c32eeca5e961b4`

### llm:business-growth+data-operations（1）

- GiNi Labor Management — producthunt — `prd_ecaf73924a23d1ac729d1b8e`

### llm:software-development+security-testing（1）

- Staurax Inc. — producthunt — `prd_64838bc909cfb5635f409c58`

### llm:research-learning+software-development（1）

- Show HN: Learn to become a Rave Developer for the airline industry — showhn — `prd_6b3adbbd89faa559eae40e99`

