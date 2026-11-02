const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../web/shared.js');
const { validateLocalization } = require('../.agents/skills/community-pulse/scripts/enhance.js');
const { ruleDrop } = require('../scripts/catalog/travel-mobility-review.js');

// 规则分层：标题/标签是主判据，正文只认高特异性短语或多个不同词。这些用例守的是
// 2026-10 回归的四类误判（视频模板名、正文偶然提及、行业软件、工程术语），
// 以及旧正则漏掉的复数 / visa-free / eSIM / 机场休息室等真实旅行工具。
test('travel-mobility keeps real travel products, including plurals and support tools', () => {
  const positives = [
    { title: 'RoadTrip', summary: '检查自驾行程、景点开放时间和酒店预订的旅行规划助手' },
    { title: 'Hotel booking', summary: 'Book hotels in Paris and compare city guides for Tokyo.' },
    { title: 'Cheap flights', summary: 'Compare airlines and find cheap flights to Rome.' },
    { title: 'VisaFree', summary: '30-day visa-free entry rules and arrival card checklists.' },
    { title: 'ONE eSIM', summary: 'Prepaid travel eSIM data plans for 200+ destinations.' },
    { title: 'Lounge Frog', summary: 'Find every airport lounge at any terminal, with opening hours.' },
    { title: 'Stay180', summary: 'Schengen short-stay planner: add past and planned stays and see days used.' },
    { title: 'Seiton Paw', summary: 'AI platform for international pet travel paperwork and airline rules.' },
    { title: 'Trawise', summary: 'Booking, the other way round: a traveller drops a pin and sets a radius.' },
    { title: 'RoamVista', summary: '免注册云旅行：转动交互式地球，从 120 座城市中选择目的地' },
    { title: 'Tripboard', summary: 'Itinerary and map side by side; keep flights, hotels and checklists with the trip.' },
  ];
  for (const item of positives) assert.equal(D.travelMobility(item).relevant, true, item.title);
});

test('travel-mobility rejects video templates, incidental mentions, and unrelated software', () => {
  const negatives = [
    { title: 'Hotel Lobby AI', summary: 'Turn two photos into a 15-second rap duet in an orange studio.' },
    { title: 'Raindance Maker', summary: 'Recast the viral seaside-pier Raindance AI video from two photos.' },
    { title: 'DanseAI', summary: 'Turns two photos into AI dance duets: Alors on Danse, Hotel Lobby, Zombie AI.' },
    { title: '【开源自荐】Muralume：轻巧精致的 Mac 视频播放器与动态桌面', summary: '你可以把自己的旅行、宠物或延时摄影视频设为动态壁纸。' },
    { title: 'Show HN: Hashsync – Deduplicate SSH streams', summary: 'On a recent trip, stuck on spotty hotel Wi-Fi and roaming 5G, I deduplicate SSH streams.' },
    { title: 'MINERVA ERP', summary: 'ERP for schools: attendance, exams, fees, hostel and transport records.' },
    { title: 'Portable USB Blenders', summary: 'Smoothies at home, work, the gym, or while traveling.' },
    { title: 'Win $480 to Spend Your Way', summary: 'Shop, travel, eat out or save it. A free giveaway for readers in 7 countries.' },
    { title: 'OrcaReplay', summary: 'Time travel for AI agents. Record, replay, fork, and debug any agent run.' },
    { title: 'Passport.js', summary: 'Authentication middleware for Node.js.' },
    { title: 'Crypto Travel Rule Compliance', summary: 'Complete audit-ready Travel Rule compliance for VASPs.' },
    { title: 'Tour Diary', summary: 'Input your office trip journey details and generate a tour diary for TA/DA expenses.' },
    { title: 'ForHotel — Cloud Hotel PMS', summary: 'All-in-one cloud PMS, booking engine and channel manager for hotels.' },
  ];
  for (const item of negatives) assert.equal(D.travelMobility(item).relevant, false, item.title);
});

test('explicit historical lifestyle tags are promoted only when the new rule agrees', () => {
  const promoted = D.itemTaxonomy({ title: 'RoamVista', summary: '免注册云旅行：转动交互式地球，从 120 座城市中选择目的地', taxonomy: { useCases: ['lifestyle-entertainment'] } });
  assert.deepEqual(promoted.useCases, ['travel-mobility']);
  const untouched = D.itemTaxonomy({ title: 'Bean Stuff', summary: 'Find quality coffee worth your time.', taxonomy: { useCases: ['lifestyle-entertainment'] } });
  assert.deepEqual(untouched.useCases, ['lifestyle-entertainment']);
});

test('rule pre-filter names the template and engineering traps explicitly', () => {
  assert.equal(ruleDrop({ title: 'Hotel Lobby AI', summary: 'two photos, orange studio' }), 'video-template-name');
  assert.equal(ruleDrop({ title: 'FocusTrek', summary: 'Travel through time. One focus at a time.' }), 'engineering-phrase:time-travel');
  assert.equal(ruleDrop({ title: 'Crypto Travel Rule Compliance', summary: 'audit-ready Travel Rule compliance' }), 'engineering-phrase:travel-rule');
  assert.equal(ruleDrop({ title: 'RoadTrip', summary: '自驾行程与酒店预订' }), null);
});

test('localize contract produces a real titleZh for English sources and keeps brands', () => {
  const taxonomy = { useCases: ['travel-mobility'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  const item = { title: 'Tripboard', desc: 'Itinerary and map side by side.', section: 'Product Hunt' };
  const translated = validateLocalization({
    titleZh: 'Tripboard：行程与地图并排的旅行规划工具', summaryZh: '把行程和地图并排显示。', summaryEn: 'Itinerary and map side by side.',
    primaryCategory: 'productivity-collaboration', taxonomy,
  }, item);
  assert.match(translated.titleZh, /[\u3400-\u9fff]/);
  // 纯品牌名可以原样回传，但不能用一个英文描述冒充中文标题。
  assert.equal(validateLocalization({ titleZh: 'Tripboard', summaryZh: '行程', summaryEn: 'trip', primaryCategory: 'other', taxonomy }, item).titleZh, 'Tripboard');
  assert.throws(() => validateLocalization({ titleZh: 'A trip planner', summaryZh: '行程', summaryEn: 'trip', primaryCategory: 'other', taxonomy }, item), /titleZh/);
});
