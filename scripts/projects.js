const D = require('../web/shared.js');
const R = require('./render-site.js');
const { t, escapeHtml: e, localPath: lp } = D;
function buildProjects(reports) {
  const catalog = new Map();
  // Newest report first; merge only older missing metadata, never overwrite recent observations.
  for (const report of [...reports].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const source of report.results || []) {
      for (const item of source.items || []) {
        delete item.projectPath;
        const repo = D.repository(item);
        if (!repo) continue;
        item.projectPath = repo.path;
        const snapshot = { ...item, sourceId: item.sourceId || source.sourceId, sourceName: source.sourceName, reportDate: report.date };
        if (!catalog.has(repo.key)) catalog.set(repo.key, {
          ...repo, firstSeen: report.date, lastSeen: report.date, item: snapshot,
          observations: new Map(), topics: new Set(), related: [], snapshotDate: snapshot.github?.snapshotDate || report.date,
        });
        const project = catalog.get(repo.key);
        project.firstSeen = report.date < project.firstSeen ? report.date : project.firstSeen;
        // Pick one coherent GitHub metadata snapshot instead of mixing fields across dates.
        if (!project.item.github && snapshot.github) {
          project.item.github = snapshot.github;
          project.snapshotDate = snapshot.github.snapshotDate || report.date;
        }
        if (!project.item.summaryEn && (snapshot.summaryEn || snapshot.summary_en)) project.item.summaryEn = snapshot.summaryEn || snapshot.summary_en;
        if (!project.item.summaryZh && (snapshot.summaryZh || snapshot.summary_zh)) project.item.summaryZh = snapshot.summaryZh || snapshot.summary_zh;
        if (!D.taxonomyHasValues(project.item.taxonomy) && D.taxonomyHasValues(snapshot.taxonomy)) project.item.taxonomy = D.normalizeTaxonomy(snapshot.taxonomy);
        // Screenshots come from whichever observation published them (VibeCafé products carry 1-9).
        if (!project.item.images?.length && snapshot.images?.length) project.item.images = snapshot.images;
        if (report.date === project.lastSeen && snapshot.summarySource === 'llm-final' && project.item.summarySource !== 'llm-final') {
          project.item.summary = snapshot.summary; project.item.summarySource = snapshot.summarySource;
        }
        for (const topic of item.github?.topics || []) project.topics.add(topic);
        if (!project.observations.has(report.date)) project.observations.set(report.date, { date: report.date, sources: [], item: snapshot });
        const observation = project.observations.get(report.date);
        const sourceUrl = D.safeUrl(item.issueUrl || item.relatedIssue || item.vibecafeUrl || item.productHuntUrl || item.url) || repo.url;
        if (!observation.sources.some(entry => entry.sourceId === source.sourceId && entry.url === sourceUrl)) observation.sources.push({ sourceId: source.sourceId, sourceName: source.sourceName, url: sourceUrl });
      }
    }
  }
  const projects = [...catalog.values()].map(project => ({ ...project, topics: [...project.topics], observations: [...project.observations.values()] })).sort((a, b) => a.key.localeCompare(b.key));
  // Inverted topic index keeps related-project matching bounded by actual shared topics.
  const topics = new Map();
  for (const project of projects) for (const topic of project.topics) {
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push(project);
  }
  for (const project of projects) {
    const scores = new Map();
    for (const topic of project.topics) for (const other of topics.get(topic)) {
      if (other.key !== project.key) scores.set(other, (scores.get(other) || 0) + 1);
    }
    project.related = [...scores].sort((a, b) => b[1] - a[1] || b[0].lastSeen.localeCompare(a[0].lastSeen) || a[0].key.localeCompare(b[0].key))
      .slice(0, 3).map(([other]) => ({ key: other.key, path: other.path, name: other.fullName, language: D.metric(other.item, ['language', 'lang']) }));
    // Use a stable, concise repository name on detail pages.
    project.item = { ...project.item, title: project.fullName, githubUrl: project.url, projectPath: project.path };
  }
  return projects;
}
function projectPage(project, locale) {
  const item = project.item, s = D.summary(item, locale);
  const title = `${project.fullName} | DevTrends`;
  const intro = t(locale, 'projectIntro', { name: project.fullName });
  const description = s.original ? intro : `${project.fullName} — ${s.text}`.slice(0, 165);
  const canonical = D.origin + lp(project.path, locale);
  const stars = D.metric(item, ['stars', 'stargazers_count', 'totalStars']);
  const forks = D.metric(item, ['forks', 'forks_count']);
  const language = D.metric(item, ['language', 'lang']);
  const license = typeof item.github?.license === 'string' ? item.github.license : item.github?.license?.spdx_id;
  const snapshotDate = project.snapshotDate;
  const shortSummary = s.text.length > 220 ? s.text.slice(0, 220) + '…' : s.text;
  const links = D.itemLinks(item).filter(([label]) => label !== 'source');
  const facts = [['owner', project.owner], ['programmingLanguage', language], ['license', license && license !== 'NOASSERTION' ? license : null], ['stars', stars !== null ? new Intl.NumberFormat(locale).format(Number(stars)) : null], ['forks', forks !== null ? new Intl.NumberFormat(locale).format(Number(forks)) : null]].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const factsHtml = list => `<dl class="facts">${list.map(([key, value]) => `<div><dt>${t(locale, key)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>`;
  const related = project.related.length ? `<section class="panel"><h2>${t(locale, 'related')}</h2><div class="related-list">${project.related.map(other => `<a href="${lp(other.path, locale)}"><b>${e(other.name)}</b>${other.language ? `<span>${e(other.language)}</span>` : ''}</a>`).join('')}</div></section>` : '';
  const gallery = D.galleryHtml(D.mediaEntries(item), locale);
  const galleryPanel = gallery ? `<section class="panel" id="screenshots"><h2>${t(locale, 'gallery')}</h2>${gallery}</section>` : '';
  const markUrl = D.itemMark(item), markTone = D.markClass(item);
  const source = D.sourceInfo(item), sourceName = D.sourceName(item, locale);
  const sourceUrl = D.itemLinks(item).find(([label]) => label === 'source')?.[1];
  const sourceBadge = source?.logo ? `<img src="${e(source.logo)}" alt="${e(sourceName)}" loading="lazy" />` : e(sourceName.slice(0, 2));
  const sourceLine = `<div class="project-source-line"><span class="source-mini" aria-hidden="true">${sourceBadge}</span>${sourceUrl ? `<a href="${e(D.trackedUrl(sourceUrl, item, project.lastSeen))}" target="_blank" rel="noopener noreferrer">${e(sourceName)} ↗</a>` : `<span>${e(sourceName)}</span>`}<time datetime="${project.lastSeen}">${e(D.dateLabel(project.lastSeen, locale))}</time></div>`;
  const initials = e(project.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2));
  const seenTags = new Set();
  const detailTags = [
    ...D.taxonomyTagEntries(item, locale, 8).map(entry => ({ label: entry.label, origin: 'devtrends', path: entry.path })),
    ...(language ? [{ label: language, origin: 'language' }] : []),
    ...project.topics.map(label => ({ label, origin: 'source' })),
  ].filter(tag => { const key = String(tag.label).toLowerCase(); if (!key || seenTags.has(key)) return false; seenTags.add(key); return true; }).slice(0, 12);
  const content = `<nav class="breadcrumb" aria-label="${locale === 'en' ? 'Breadcrumb' : '面包屑导航'}"><a href="${lp('/', locale)}">${t(locale, 'discover')}</a><span>/</span><span>${t(locale, 'details')}</span></nav>
    <article class="project-hero"><div class="project-identity"><span class="project-mark${markUrl ? ` has-logo${markTone}` : ''}" aria-hidden="true">${markUrl ? `<img src="${e(markUrl)}" class="is-logo" alt="${e(`${project.owner}/${project.name}`)}" />` : initials}</span><div class="project-heading"><div>${sourceLine}<p class="project-owner">${e(project.owner)} /</p><h1>${e(project.name)}</h1></div></div></div>
    <p class="project-summary" lang="${s.lang}">${e(shortSummary)}</p>${s.original ? `<span class="original-label">${t(locale, 'original')}</span>` : ''}
    ${detailTags.length ? `<div class="project-tags">${detailTags.map(tag => D.tagHtml(tag, locale)).join('')}</div>` : ''}
    <div class="project-links">${links.map(([label, url], i) => `<a class="button${i === 0 ? ' primary' : ''}" href="${e(D.trackedUrl(url, item, project.lastSeen))}" target="_blank" rel="noopener noreferrer">${t(locale, label)} ${D.icon('arrow')}</a>`).join('')}</div></article>
    <div class="project-layout"><div>
      ${galleryPanel}
      <section class="panel" id="about"><h2>${t(locale, 'about')}</h2>${s.original ? `<p class="caption">${t(locale, 'translationNote')}</p>` : ''}<p lang="${s.lang}">${e(s.text)}</p><p class="caption">${t(locale, 'summaryNote')}</p></section>
      <section class="panel" id="history"><h2>${t(locale, 'timeline')}</h2><p class="caption">${t(locale, 'timelineHint')}</p><ol class="timeline">${project.observations.map(observation => {
        const text = D.summary(observation.item, locale);
        return `<li><a href="${lp(`/reports/${observation.date}/`, locale)}"><time datetime="${observation.date}">${e(D.dateLabel(observation.date, locale))}</time> ↗</a><p lang="${text.lang}">${e(text.text)}</p>${text.original ? `<span class="original-label">${t(locale, 'original')}</span>` : ''}<div class="source-links">${observation.sources.map(source => `<a href="${e(D.trackedUrl(source.url, observation.item, observation.date))}" target="_blank" rel="noopener noreferrer">${e(D.sourceName(source, locale))} ↗</a>`).join('')}</div></li>`;
      }).join('')}</ol></section></div>
      <aside class="project-sidebar"><section class="panel"><h2>${t(locale, 'facts')}</h2>${factsHtml(facts)}<p class="caption">${e(t(locale, 'snapshot', { date: D.dateLabel(snapshotDate, locale) }))}</p>${item.github?.archived ? `<span class="original-label">${t(locale, 'archived')}</span>` : ''}</section>
      <section class="panel">${factsHtml([['firstSeen', D.dateLabel(project.firstSeen, locale)], ['lastSeen', D.dateLabel(project.lastSeen, locale)], ['appearances', t(locale, 'days', { n: project.observations.length })]])}</section>${related}</aside></div>
    ${R.commentsSection({ term: `project:${project.key}`, locale, kind: 'project' })}`;
  const structured = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description, inLanguage: locale, dateModified: project.lastSeen, isPartOf: { '@id': D.origin + '/#website' }, mainEntity: { '@id': canonical + '#repository' }, breadcrumb: { '@id': canonical + '#breadcrumb' } },
      { '@type': 'SoftwareSourceCode', '@id': canonical + '#repository', name: project.fullName, description: s.text, codeRepository: project.url, url: canonical, dateCreated: project.firstSeen, dateModified: project.lastSeen, ...(language ? { programmingLanguage: language } : {}), ...(license && license !== 'NOASSERTION' ? { license } : {}) },
      { '@type': 'BreadcrumbList', '@id': canonical + '#breadcrumb', itemListElement: [
        { '@type': 'ListItem', position: 1, name: t(locale, 'discover'), item: D.origin + lp('/', locale) },
        { '@type': 'ListItem', position: 2, name: project.fullName, item: canonical },
      ] },
    ],
  };
  return R.shell({ locale, view: 'project', route: project.path, title, description, content, data: { projectItem: item, date: project.lastSeen }, structured });
}
module.exports = { buildProjects, projectPage };
