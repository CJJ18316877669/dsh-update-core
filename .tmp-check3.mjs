const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const credential = Object.fromEntries(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  .filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const auth = `Basic ${Buffer.from(`${credential.username || 'x-access-token'}:${credential.password}`).toString('base64')}`;
const base = 'https://api.github.com/repos/CJJ18316877669/dsh-update-core';
const request = (url) => fetch(url, { headers: { authorization: auth, accept: 'application/vnd.github+json' } });
const runs = await (await request(`${base}/actions/runs?per_page=6`)).json();
for (const run of (runs.workflow_runs || []).filter((item) => item.head_sha.startsWith('84062c7'))) {
  const jobs = await (await request(run.jobs_url)).json();
  const states = (jobs.jobs || []).map((job) => job.conclusion || job.status);
  process.stdout.write(`${run.name} ${run.status}/${run.conclusion} success=${states.filter((s) => s === 'success').length} total=${states.length}\n`);
  for (const job of (jobs.jobs || []).filter((entry) => entry.conclusion === 'failure')) {
    const text = await (await request(`${base}/actions/jobs/${job.id}/logs`)).text();
    process.stdout.write(`FAIL ${job.name}\n${text.split(/\r?\n/).filter((line) => /not ok|# fail|error:/.test(line)).slice(-6).join('\n')}\n`);
  }
}
const release = await (await request(`${base}/releases/tags/v0.2.3`)).json();
process.stdout.write(`release=${release.tag_name || release.message} asset=${release.assets?.[0]?.name} digest=${release.assets?.[0]?.digest}\n`);
