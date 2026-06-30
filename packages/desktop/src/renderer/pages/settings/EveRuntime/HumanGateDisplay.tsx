/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HumanGateDisplay — read-only "Genehmigungsleitern" (HumanGate ladder).
 *
 * This is a PURE DISPLAY card. There are NO buttons and NO editing — gate levels
 * are not user-configurable in 1.2.18. It surfaces OUR orchestration model (the
 * conductor + the gate ladder) honestly, without implying it can be changed.
 *
 * Ladder copy is the founder-confirmed canonical source
 * (docs/governance/human-gate-levels.md): Founder = HG-4 · EVE = HG-3.5 ·
 * CEO = HG-3 · Releases ≤ HG-2.5 = autonom. NEVER write "Founder HG-2.5".
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

type GateRow = {
  level: string;
  actor: string;
  meaning: string;
};

const EveRuntimeHumanGateDisplay: React.FC = () => {
  const { t } = useTranslation();

  // NOTE: these are FIXED, read-only rows. Do NOT wire any setter here — the
  // gate ladder is governance canon, not a renderer-editable setting (1.2.18).
  const rows: GateRow[] = [
    {
      level: 'HG-4',
      actor: t('eveRuntime.humanGate.founder', { defaultValue: 'Gründer / Mensch' }),
      meaning: t('eveRuntime.humanGate.founderMeaning', {
        defaultValue: 'Vertrauensgrenze. Deploy/Produktion, Unumkehrbares, Veröffentlichen, Identität.',
      }),
    },
    {
      level: 'HG-3.5',
      actor: t('eveRuntime.humanGate.eve', { defaultValue: 'EVE / Chief-of-Staff' }),
      meaning: t('eveRuntime.humanGate.eveMeaning', {
        defaultValue: 'Gründer-Proxy: prüft, übersetzt, fordert heraus. Kann HG-4 nicht freigeben.',
      }),
    },
    {
      level: 'HG-3',
      actor: t('eveRuntime.humanGate.ceo', { defaultValue: 'CEO (Codex)' }),
      meaning: t('eveRuntime.humanGate.ceoMeaning', {
        defaultValue: 'CEO-kritische Freigabe-Autorität.',
      }),
    },
    {
      level: '≤ HG-2.5',
      actor: t('eveRuntime.humanGate.autonomous', { defaultValue: 'Autonom (CEO/Codex)' }),
      meaning: t('eveRuntime.humanGate.autonomousMeaning', {
        defaultValue: 'Begrenzte, umkehrbare Freigaben — autonom entscheidbar.',
      }),
    },
  ];

  return (
    <section className='rounded-16px border border-solid border-[var(--color-border-2)] bg-bg-2 px-18px py-16px'>
      <header className='mb-3'>
        <div className='text-base font-medium text-t-primary'>
          {t('eveRuntime.humanGate.title', { defaultValue: 'Genehmigungsleitern' })}
        </div>
        <div className='text-sm text-t-secondary'>
          {t('eveRuntime.humanGate.subtitle', {
            defaultValue:
              'Wer was freigeben darf. Du bist der Dirigent — EVE orchestriert, gibt aber nichts Unumkehrbares ohne dich frei.',
          })}
        </div>
      </header>

      <div className='flex flex-col gap-2'>
        {rows.map((row) => (
          <div
            key={row.level}
            className='flex items-start gap-3 rounded-12px border border-solid border-[var(--color-border-2)] bg-bg-1 px-12px py-10px'
          >
            <span className='shrink-0 rounded-8px bg-[var(--color-fill-2)] px-8px py-2px text-xs font-600 text-t-primary'>
              {row.level}
            </span>
            <div className='min-w-0'>
              <div className='text-sm font-500 text-t-primary'>{row.actor}</div>
              <div className='text-xs text-t-secondary'>{row.meaning}</div>
            </div>
          </div>
        ))}
      </div>

      <p className='m-0 mt-3 text-xs text-t-secondary'>
        {t('eveRuntime.humanGate.readonlyFooter', {
          defaultValue: 'Read-only; Bearbeitung kommt mit Eval-Gates + Worker-Zuweisung.',
        })}
      </p>
    </section>
  );
};

export default EveRuntimeHumanGateDisplay;
