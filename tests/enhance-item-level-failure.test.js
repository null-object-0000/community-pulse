/**
 * 「条目自身分类不了」与「系统性故障」必须区别对待的回归用例。
 *
 * 守的是：**一条垃圾投稿不该让整期日报没有中文。**
 *
 * 2026-09-23 实测：阮一峰周刊 Issue 11874 标题字面是 `lost`、正文只有 `good`。
 * 模型读这段描述无论如何给不出受控业务场景，校验层拒绝（这是对的）——
 * 但 `localize()` 的重试循环空转 5 次之后抛错，而批处理里 `if (failures.length) throw failures[0]`
 * 让**整期 71 条增强全部中止**，final 文件一个字节都没产出，用户当天收不到日报。
 *
 * 分界：
 * - **条目级**（校验层拒绝）：重试不会变好 → 跳过这一条（日报里保留原文），并显式报出。
 * - **系统性**（LLM 网关 HTTP 错误 / 网络 / 限流打满）：必须整批停下来 ——
 *   否则会静默产出一期只有零星中文的残缺日报，比失败更危险。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const { localize, validateLocalization } = require(path.join(SKILL, 'enhance.js'));

/** 造一个假 LLM 响应：OpenAI 兼容的 chat/completions。 */
function llmReturning(payload, onCall) {
  return async () => {
    onCall?.();
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };
}

const noSleep = async () => {};
const GARBAGE_ITEM = { idx: 0, title: 'lost', desc: 'good', section: '周刊·投稿' };

test('垃圾投稿（模型给不出业务场景）标成条目级失败，且只试一次不空转', async () => {
  let calls = 0;
  // 模型每次都给「没有 useCases」的结果 —— 校验层必然拒绝，重试多少次都一样。
  const original = global.fetch;
  global.fetch = llmReturning({ summaryZh: '中文', summaryEn: 'English', primaryCategory: 'developer-tools', taxonomy: { useCases: [], agentRoles: [], productForms: [], platforms: [], integrations: [] } }, () => { calls += 1; });
  try {
    await assert.rejects(
      () => localize(GARBAGE_ITEM, { sleep: noSleep }),
      (error) => {
        assert.equal(error.itemLevel, true, '应当标成条目级失败（可跳过）');
        assert.match(error.message, /useCases/);
        return true;
      },
    );
    assert.equal(calls, 1, `条目级失败不该重试（实际请求 ${calls} 次）`);
  } finally {
    global.fetch = original;
  }
});

test('LLM 网关 HTTP 错误是系统性故障：不标条目级（调用方必须整批停）', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 502, headers: new Map(), json: async () => ({}) });
  try {
    await assert.rejects(
      () => localize({ ...GARBAGE_ITEM, title: '正常项目' }, { sleep: noSleep }),
      (error) => {
        assert.notEqual(error.itemLevel, true, '系统性故障绝不能标成可跳过 —— 否则会静默产出残缺日报');
        return true;
      },
    );
  } finally {
    global.fetch = original;
  }
});

test('校验层拒绝的原始错误仍带可读原因（供跳过日志引用）', () => {
  assert.throws(
    () => validateLocalization(
      { summaryZh: '中文', summaryEn: 'English', primaryCategory: 'developer-tools', taxonomy: { useCases: [], agentRoles: [], productForms: [], platforms: [], integrations: [] } },
      GARBAGE_ITEM),
    /至少需要一个受控业务场景/,
  );
});