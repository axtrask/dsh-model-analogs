/**
 * The card's browser half.
 *
 * It registers into the seat the Models page already dispatches at its bottom
 * (`settings.models.footer`) and speaks one JSON channel with
 * `lib/plugin.js` — the same "prefix route on the Web server" arrangement the
 * shipped settings pages use for their own fetches. No build step: this file is
 * the module the profile loader hands to the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-analogs',
  factory(require) {
    return {
      inject: ['slots'],
      apply(ctx) {
        const React = require('react');
        const h = React.createElement;
        /** The channel `cordis.patch.yml` configures; both halves must agree. */
        const ENDPOINT = '/model-analogs/api';

        /**
         * Call one method of the plugin's protocol.
         * @param method - the method name.
         * @param payload - its arguments.
         * @returns the answered value.
         */
        async function call(method, payload) {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, payload })
          });
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            throw new Error(text.slice(0, 200) || `Host answered ${String(response.status)}`);
          }
          if (body !== null && typeof body === 'object' && typeof body.error === 'string') throw new Error(body.error);
          return body;
        }

        /**
         * Show a number the way a model card should.
         * @param value - the count.
         * @returns the formatted count, or a dash.
         */
        function count(value) {
          return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
        }

        /**
         * Describe one model row's reasoning declaration.
         * @param efforts - the entry's `reasoningEfforts`.
         * @returns a short human label.
         */
        function reasoningLabel(efforts) {
          if (efforts === false) return 'без ризонинга';
          if (efforts === undefined) return 'как у роута';
          return Object.keys(efforts).map((level) => `${level}→${String(efforts[level])}`).join(' · ');
        }

        const label = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };
        const field = { minHeight: 30, padding: '4px 8px', font: 'inherit', fontSize: 12, color: 'inherit',
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l3, #80808050)', borderRadius: 6 };
        const button = { alignSelf: 'flex-start', minHeight: 30, padding: '4px 12px', font: 'inherit', fontSize: 12,
          color: 'inherit', background: 'var(--dsw-alias-interactive-bg-hover, #80808020)', cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l3, #80808050)', borderRadius: 6 };
        const muted = { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 };

        function ModelAnalogsCard() {
          const [state, setState] = React.useState({ status: 'loading' });
          const [busy, setBusy] = React.useState(false);
          const [notice, setNotice] = React.useState('');
          const [like, setLike] = React.useState('');
          const [filter, setFilter] = React.useState('');
          const [id, setId] = React.useState('');
          const [name, setName] = React.useState('');
          const [maxTokens, setMaxTokens] = React.useState('');
          const [analogy, setAnalogy] = React.useState(undefined);

          const adopt = React.useCallback((value) => {
            setState({ status: 'ready', value });
          }, []);

          React.useEffect(() => {
            let live = true;
            call('state').then((value) => {
              if (live) adopt(value);
            }).catch((error) => {
              if (live) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
            });
            return () => {
              live = false;
            };
          }, [adopt]);

          const value = state.status === 'ready' ? state.value : undefined;
          React.useEffect(() => {
            if (value === undefined || maxTokens.length > 0) return;
            if (typeof value.defaultMaxTokens === 'number') setMaxTokens(String(value.defaultMaxTokens));
          }, [value, maxTokens]);
          const catalog = value?.catalog ?? [];
          const needle = filter.trim().toLowerCase();
          const options = (needle.length === 0 ? catalog : catalog.filter((row) =>
            row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))).slice(0, 300);

          const choose = async (next) => {
            setLike(next);
            setAnalogy(undefined);
            if (next.length === 0) return;
            try {
              const answer = await call('analogy', { like: next });
              setAnalogy(answer.analogy);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            }
          };

          const submit = async () => {
            if (busy) return;
            setBusy(true);
            setNotice('');
            try {
              const parsed = Number.parseInt(maxTokens, 10);
              adopt(await call('add', {
                like,
                id,
                name,
                maxTokens: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined,
                copyReasoning: true
              }));
              try {
                const probe = await call('verify', { id });
                setNotice(`Готово: ${probe.name} · ${probe.provider}/${probe.id} · ctx ${count(probe.contextWindow)} · уровни ${probe.levels.join(' / ') || 'нет'}`);
              } catch (error) {
                setNotice(`Записано, но роут не разрешил модель: ${error instanceof Error ? error.message : String(error)}`);
              }
              setId('');
              setName('');
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          };

          const remove = async (target) => {
            if (busy) return;
            setBusy(true);
            setNotice('');
            try {
              adopt(await call('remove', { id: target }));
              setNotice(`Удалено: ${target}`);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          };

          const writable = value?.writable !== false;
          const canAdd = writable && !busy && like.length > 0 && id.trim().length > 0;

          return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16,
            padding: 14, border: '1px solid var(--dsw-alias-border-l3, #80808050)', borderRadius: 10 } },
            h('header', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('h3', { style: { margin: 0, fontSize: 14 } }, 'Модели по аналогии'),
              h('p', { style: { ...muted, margin: 0 } },
                value === undefined ? 'Плагин не ответил.' :
                  `Скопировать возможности модели каталога «${value.catalogRoute}» в новый id и записать его в роут «${value.route}».`)),

            state.status === 'error' ? h('p', { role: 'alert', style: { ...muted, margin: 0 } }, state.message) : null,

            value === undefined ? null : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' } },
              h('label', { style: label }, 'Поиск в каталоге',
                h('input', { style: field, value: filter, placeholder: 'kimi, claude, gemini…', disabled: !writable,
                  onChange: (event) => setFilter(event.currentTarget.value) })),
              h('label', { style: { ...label, minWidth: 240 } }, 'По аналогии с',
                h('select', { style: field, value: like, disabled: !writable,
                  onChange: (event) => { choose(event.currentTarget.value).catch(() => {}); } },
                  h('option', { value: '' }, `— выбрать из ${String(catalog.length)} моделей —`),
                  ...options.map((row) => h('option', { key: row.id, value: row.id }, `${row.name} · ${row.id}`)))),
              h('label', { style: { ...label, minWidth: 220 } }, 'Новый id',
                h('input', { style: field, value: id, disabled: !writable, placeholder: 'moonshotai/kimi-k3.1-pro',
                  onChange: (event) => setId(event.currentTarget.value) })),
              h('label', { style: { ...label, minWidth: 180 } }, 'Название',
                h('input', { style: field, value: name, disabled: !writable, placeholder: 'Kimi K3.1 Pro',
                  onChange: (event) => setName(event.currentTarget.value) })),
              h('label', { style: { ...label, minWidth: 110 } }, 'maxTokens',
                h('input', { style: field, type: 'number', min: 1, step: 1, value: maxTokens, disabled: !writable,
                  onChange: (event) => setMaxTokens(event.currentTarget.value) })),
              h('button', { type: 'button', style: { ...button, opacity: canAdd ? 1 : 0.6 }, disabled: !canAdd,
                onClick: () => { submit().catch(() => {}); } }, busy ? 'Пишу…' : 'Добавить')),

            analogy === undefined ? null : h('p', { style: { ...muted, margin: 0 } },
              `Из ${analogy.like}: контекст ${count(analogy.contextWindow)}` +
              ` · вход ${analogy.input.join('+') || 'text'} · уровни ${analogy.levels.join(' / ') || 'нет'}` +
              ' · maxTokens не публикуется каталогом, поэтому берётся из поля выше'),

            value !== undefined && value.models.length > 0 ? h('ul', { style: { listStyle: 'none', margin: 0, padding: 0,
              display: 'flex', flexDirection: 'column', gap: 6 } },
              ...value.models.map((model) => h('li', { key: model.id,
                style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', fontSize: 12 } },
                h('strong', null, model.name),
                h('code', { style: muted }, model.id),
                h('span', { style: muted }, `ctx ${count(model.contextWindow)} · max ${count(model.maxTokens)} · ${model.input.join('+') || 'text'} · ${reasoningLabel(model.reasoningEfforts)}`),
                h('button', { type: 'button', style: { ...button, marginLeft: 'auto' }, disabled: !writable || busy,
                  onClick: () => { remove(model.id).catch(() => {}); } }, 'Удалить'))))
              : value === undefined ? null : h('p', { style: { ...muted, margin: 0 } },
                `Роут «${value.route}» пока пуст: добавьте первую модель.`),

            value !== undefined && !writable ? h('p', { style: { ...muted, margin: 0 } }, 'Профиль не принимает записи.') : null,
            notice.length > 0 ? h('p', { role: 'status', 'aria-live': 'polite', style: { ...muted, margin: 0 } }, notice) : null);
        }

        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'model-analogs',
          order: 50
        }, ModelAnalogsCard));
      }
    };
  }
});
