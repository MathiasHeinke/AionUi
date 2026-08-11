/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_COMPONENTS, type TypedUIJsonValue } from '@/common/typedUI';
import {
  Alert,
  Avatar,
  Button,
  Carousel,
  Checkbox,
  Collapse,
  Divider,
  Input,
  Pagination,
  Popover,
  Progress,
  Radio,
  Select,
  Skeleton,
  Slider,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
} from '@arco-design/web-react';
import type { ComponentRegistry, ComponentRenderProps } from '@json-render/react';
import { useStateStore } from '@json-render/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { TYPED_UI_INTERNAL_UNAVAILABLE_ACTIONS } from './actions';
import styles from './TypedGenerativeUI.module.css';

type Props = Record<string, unknown>;

function stringProp(props: Props, key: string, fallback = ''): string {
  const value = props[key];
  return typeof value === 'string' ? value : fallback;
}

function numberProp(props: Props, key: string, fallback = 0): number {
  const value = props[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanProp(props: Props, key: string, fallback = false): boolean {
  const value = props[key];
  return typeof value === 'boolean' ? value : fallback;
}

function arrayProp<T>(props: Props, key: string): T[] {
  return Array.isArray(props[key]) ? (props[key] as T[]) : [];
}

function tone(value: unknown): string {
  return typeof value === 'string' ? value : 'neutral';
}

function unavailableActionReason(props: Props, event: string): string | undefined {
  const value = props[TYPED_UI_INTERNAL_UNAVAILABLE_ACTIONS];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reason = (value as Record<string, unknown>)[event];
  return typeof reason === 'string' && reason ? reason : undefined;
}

function CatalogComponent({ element, children, emit, on, loading }: ComponentRenderProps) {
  const { t } = useTranslation();
  const { get, set } = useStateStore();
  const props = element.props as Props;
  const statePath = stringProp(props, 'statePath');
  const stateValue = statePath ? get(statePath) : undefined;
  const childArray = React.Children.toArray(children);
  const updateState = (value: TypedUIJsonValue, event?: string) => {
    if (event && on(event).bound) {
      emit(event);
      return;
    }
    if (statePath) set(statePath, value);
  };

  switch (element.type) {
    case 'Card':
      return (
        <section className={styles.card} data-tone={tone(props.tone)}>
          {props.title ? <h3 className={styles.cardTitle}>{stringProp(props, 'title')}</h3> : null}
          {props.subtitle ? <p className={styles.muted}>{stringProp(props, 'subtitle')}</p> : null}
          {children}
        </section>
      );
    case 'Stack':
      return (
        <div
          className={styles.stack}
          data-direction={stringProp(props, 'direction', 'vertical')}
          data-align={stringProp(props, 'align', 'stretch')}
          style={{ gap: `${numberProp(props, 'gap', 12)}px` }}
        >
          {children}
        </div>
      );
    case 'Grid':
      return (
        <div
          className={styles.grid}
          style={
            {
              '--typed-ui-columns': numberProp(props, 'columns', 2),
              gap: `${numberProp(props, 'gap', 12)}px`,
            } as React.CSSProperties
          }
        >
          {children}
        </div>
      );
    case 'Separator':
      return <Divider orientation='center'>{stringProp(props, 'label') || undefined}</Divider>;
    case 'Tabs': {
      const labels = arrayProp<string>(props, 'labels');
      const active = typeof stateValue === 'string' ? stateValue : '0';
      return (
        <Tabs activeTab={active} onChange={(value) => updateState(value, `select:${value}`)}>
          {labels.map((label, index) => (
            <Tabs.TabPane key={String(index)} title={label}>
              {childArray[index] ?? null}
            </Tabs.TabPane>
          ))}
        </Tabs>
      );
    }
    case 'Accordion':
    case 'Collapsible':
      return (
        <Collapse defaultActiveKey={booleanProp(props, 'defaultOpen') ? ['content'] : []}>
          <Collapse.Item name='content' header={stringProp(props, 'title') || stringProp(props, 'label')}>
            {children}
          </Collapse.Item>
        </Collapse>
      );
    case 'Dialog':
    case 'Drawer':
      if (props.open === false) return null;
      return (
        <section role='dialog' aria-modal='false' aria-label={stringProp(props, 'title')} className={styles.dialog}>
          <div className={styles.dialogHeader}>
            <h3>{stringProp(props, 'title')}</h3>
          </div>
          {children}
        </section>
      );
    case 'Carousel': {
      const current = typeof stateValue === 'number' ? stateValue : 0;
      return (
        <div aria-label={stringProp(props, 'label')} className={styles.carousel}>
          <Carousel currentIndex={current} onChange={(index) => updateState(index)} showArrow='hover'>
            {childArray.map((child, index) => (
              <div key={index} className={styles.carouselItem}>
                {child}
              </div>
            ))}
          </Carousel>
        </div>
      );
    }
    case 'Table': {
      const columns = arrayProp<{ key: string; label: string }>(props, 'columns');
      const rows = arrayProp<Record<string, TypedUIJsonValue>>(props, 'rows');
      return (
        <div className={styles.tableWrap} tabIndex={0}>
          <table className={styles.table}>
            {props.caption ? <caption>{stringProp(props, 'caption')}</caption> : null}
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} scope='col'>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column) => (
                    <td key={column.key}>{String(row[column.key] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'Heading': {
      const level = Math.min(4, Math.max(1, numberProp(props, 'level', 2)));
      const Heading = `h${level}` as keyof React.JSX.IntrinsicElements;
      return <Heading className={styles.heading}>{stringProp(props, 'text')}</Heading>;
    }
    case 'Text':
      return (
        <p className={styles.text} data-tone={tone(props.tone)}>
          {stringProp(props, 'text')}
        </p>
      );
    case 'Image':
      return (
        <figure className={styles.imagePlaceholder}>
          {on('press').bound ? (
            <Button type='outline' onClick={() => emit('press')} aria-label={stringProp(props, 'alt')}>
              {stringProp(props, 'alt')}
            </Button>
          ) : (
            <span>{stringProp(props, 'alt')}</span>
          )}
          {props.caption ? <figcaption>{stringProp(props, 'caption')}</figcaption> : null}
          <span className={styles.srOnly}>{stringProp(props, 'artifactRef')}</span>
        </figure>
      );
    case 'Avatar':
      return <Avatar aria-label={stringProp(props, 'label')}>{stringProp(props, 'initials').slice(0, 3)}</Avatar>;
    case 'Badge':
      return <Tag color={tone(props.tone)}>{stringProp(props, 'text')}</Tag>;
    case 'Alert':
      return (
        <div>
          <Alert
            type={tone(props.tone) === 'danger' ? 'error' : (tone(props.tone) as 'info' | 'success' | 'warning')}
            title={stringProp(props, 'title')}
            content={stringProp(props, 'description') || undefined}
          />
          {children}
        </div>
      );
    case 'Progress':
      return (
        <div aria-label={stringProp(props, 'label')}>
          <Progress percent={numberProp(props, 'value')} showText />
        </div>
      );
    case 'Skeleton':
      return (
        <div aria-label={stringProp(props, 'label') || t('messages.typedUI.loading')}>
          <Skeleton text={{ rows: numberProp(props, 'lines', 3) }} animation />
        </div>
      );
    case 'Spinner':
      return <Spin dot tip={stringProp(props, 'label')} />;
    case 'Tooltip':
      return (
        <Tooltip content={stringProp(props, 'content')}>
          <span tabIndex={0} className={styles.inlineWrapper}>
            {children}
          </span>
        </Tooltip>
      );
    case 'Popover':
      return (
        <Popover title={stringProp(props, 'label')} content={children}>
          <Button type='text'>{stringProp(props, 'label')}</Button>
        </Popover>
      );
    case 'Input':
      return (
        <label className={styles.field}>
          <span>{stringProp(props, 'label')}</span>
          <Input
            value={typeof stateValue === 'string' ? stateValue : ''}
            placeholder={stringProp(props, 'placeholder')}
            required={booleanProp(props, 'required')}
            maxLength={numberProp(props, 'maxLength', 2000)}
            disabled={loading}
            onChange={(value) => {
              if (statePath) set(statePath, value);
            }}
          />
        </label>
      );
    case 'Textarea':
      return (
        <label className={styles.field}>
          <span>{stringProp(props, 'label')}</span>
          <Input.TextArea
            value={typeof stateValue === 'string' ? stateValue : ''}
            placeholder={stringProp(props, 'placeholder')}
            required={booleanProp(props, 'required')}
            maxLength={numberProp(props, 'maxLength', 8000)}
            autoSize={{ minRows: numberProp(props, 'rows', 3), maxRows: 12 }}
            disabled={loading}
            onChange={(value) => {
              if (statePath) set(statePath, value);
            }}
          />
        </label>
      );
    case 'Select':
    case 'DropdownMenu': {
      const options = arrayProp<{ id: string; label: string; disabled?: boolean }>(props, 'options');
      return (
        <label className={styles.field}>
          <span>{stringProp(props, 'label')}</span>
          <Select
            value={typeof stateValue === 'string' ? stateValue : undefined}
            placeholder={stringProp(props, 'placeholder')}
            disabled={loading}
            onChange={(value) => updateState(String(value), `select:${String(value)}`)}
          >
            {options.map((option) => (
              <Select.Option key={option.id} value={option.id} disabled={option.disabled}>
                {option.label}
              </Select.Option>
            ))}
          </Select>
        </label>
      );
    }
    case 'Checkbox':
      return (
        <Checkbox checked={stateValue === true} disabled={loading} onChange={(value) => updateState(value)}>
          {stringProp(props, 'label')}
        </Checkbox>
      );
    case 'Radio':
    case 'ToggleGroup': {
      const options = arrayProp<{ id: string; label: string; disabled?: boolean }>(props, 'options');
      return (
        <fieldset className={styles.fieldset}>
          <legend>{stringProp(props, 'label')}</legend>
          <Radio.Group
            value={stateValue}
            onChange={(value) => updateState(String(value), `select:${String(value)}`)}
            disabled={loading}
            type={element.type === 'ToggleGroup' ? 'button' : 'radio'}
          >
            {options.map((option) => (
              <Radio key={option.id} value={option.id} disabled={option.disabled}>
                {option.label}
              </Radio>
            ))}
          </Radio.Group>
        </fieldset>
      );
    }
    case 'Switch':
      return (
        <label className={styles.inlineField}>
          <Switch checked={stateValue === true} disabled={loading} onChange={(value) => updateState(value)} />
          <span>{stringProp(props, 'label')}</span>
        </label>
      );
    case 'Slider': {
      const min = numberProp(props, 'min', 0);
      const max = numberProp(props, 'max', 100);
      return (
        <label className={styles.field}>
          <span>{stringProp(props, 'label')}</span>
          <Slider
            value={typeof stateValue === 'number' ? stateValue : min}
            min={min}
            max={max}
            step={numberProp(props, 'step', 1)}
            disabled={loading}
            onChange={(value) => {
              if (typeof value === 'number') updateState(value);
            }}
          />
        </label>
      );
    }
    case 'Button':
      return (
        <Button
          type={stringProp(props, 'variant', 'primary') as 'primary' | 'secondary' | 'outline' | 'text'}
          disabled={loading || booleanProp(props, 'disabled') || !on('press').bound}
          onClick={() => emit('press')}
        >
          {stringProp(props, 'label')}
        </Button>
      );
    case 'Link':
      return (
        <Button
          type='text'
          className={styles.linkButton}
          disabled={loading || !on('press').bound}
          onClick={() => emit('press')}
        >
          {stringProp(props, 'label')}
        </Button>
      );
    case 'Toggle':
      return (
        <Button
          type={stateValue === true ? 'primary' : 'outline'}
          aria-pressed={stateValue === true}
          disabled={loading}
          onClick={() => updateState(stateValue !== true)}
        >
          {stringProp(props, 'label')}
        </Button>
      );
    case 'ButtonGroup':
      return (
        <div role='group' aria-label={stringProp(props, 'label')} className={styles.buttonGroup}>
          {children}
        </div>
      );
    case 'Pagination':
      return (
        <nav aria-label={stringProp(props, 'label')}>
          <Pagination
            current={typeof stateValue === 'number' ? stateValue : 1}
            total={numberProp(props, 'total')}
            pageSize={numberProp(props, 'pageSize', 10)}
            onChange={(page) => updateState(page)}
          />
        </nav>
      );
    case 'Metric':
      return (
        <div className={styles.metric} data-tone={tone(props.tone)}>
          <span>{stringProp(props, 'label')}</span>
          <strong>{stringProp(props, 'value')}</strong>
          {props.delta ? <small>{stringProp(props, 'delta')}</small> : null}
        </div>
      );
    case 'KeyValue': {
      const items = arrayProp<{ key: string; value: string }>(props, 'items');
      return (
        <dl className={styles.keyValue}>
          {items.map((item) => (
            <React.Fragment key={item.key}>
              <dt>{item.key}</dt>
              <dd>{item.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      );
    }
    case 'Code':
      return (
        <pre className={styles.code} data-language={stringProp(props, 'language', 'text')}>
          <code>{stringProp(props, 'content')}</code>
        </pre>
      );
    case 'Markdown':
      return (
        <div className={styles.markdown}>
          <ReactMarkdown
            skipHtml
            components={{ a: ({ children: linkChildren }) => <span>{linkChildren}</span>, img: () => null }}
          >
            {stringProp(props, 'content')}
          </ReactMarkdown>
        </div>
      );
    case 'List': {
      const items = arrayProp<string>(props, 'items');
      const List = booleanProp(props, 'ordered') ? 'ol' : 'ul';
      return (
        <List className={styles.list}>
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </List>
      );
    }
    case 'Timeline': {
      const items = arrayProp<{ title: string; description?: string; time?: string; status?: string }>(props, 'items');
      return (
        <ol className={styles.timeline}>
          {items.map((item, index) => (
            <li key={`${index}-${item.title}`} data-status={item.status || 'pending'}>
              <div>
                <strong>{item.title}</strong>
                {item.time ? <time>{item.time}</time> : null}
              </div>
              {item.description ? <p>{item.description}</p> : null}
            </li>
          ))}
        </ol>
      );
    }
    case 'Goal': {
      const unavailable = ['pause', 'resume', 'cancel']
        .map((event) => unavailableActionReason(props, event))
        .find(Boolean);
      return (
        <article className={styles.eveCard} data-kind='goal'>
          <header>
            <Tag>{stringProp(props, 'status', 'planned')}</Tag>
            <span>{stringProp(props, 'id')}</span>
          </header>
          <h3>{stringProp(props, 'title')}</h3>
          {props.summary ? <p>{stringProp(props, 'summary')}</p> : null}
          {typeof props.progress === 'number' ? <Progress percent={numberProp(props, 'progress')} /> : null}
          {props.owner ? <small>{stringProp(props, 'owner')}</small> : null}
          {on('press').bound ? (
            <Button type='text' disabled={loading} onClick={() => emit('press')}>
              {t('messages.typedUI.openArtifact')}
            </Button>
          ) : null}
          {(['pause', 'resume', 'cancel'] as const).some(
            (event) => on(event).bound || unavailableActionReason(props, event)
          ) ? (
            <div
              className={styles.lifecycleControls}
              role='group'
              aria-label={t('messages.typedUI.lifecycle.controls')}
            >
              {(['pause', 'resume', 'cancel'] as const).map((event) => {
                const reason = unavailableActionReason(props, event);
                if (!on(event).bound && !reason) return null;
                return (
                  <Button
                    key={event}
                    disabled={loading || !on(event).bound}
                    aria-describedby={reason ? `typed-ui-goal-${stringProp(props, 'id')}-unavailable` : undefined}
                    onClick={() => emit(event)}
                  >
                    {t(`messages.typedUI.lifecycle.${event}`)}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {unavailable ? (
            <p
              id={`typed-ui-goal-${stringProp(props, 'id')}-unavailable`}
              className={styles.lifecycleUnavailable}
              role='status'
            >
              {t(
                unavailable === 'durable_transport_unavailable'
                  ? 'messages.typedUI.lifecycle.transportUnavailable'
                  : 'messages.typedUI.actionUnavailable'
              )}
            </p>
          ) : null}
          {children}
        </article>
      );
    }
    case 'WorkerRun': {
      const unavailable = ['pause', 'resume', 'cancel']
        .map((event) => unavailableActionReason(props, event))
        .find(Boolean);
      return (
        <article className={styles.eveCard} data-kind='worker-run'>
          <header>
            <Tag>{stringProp(props, 'status', 'queued')}</Tag>
            <span>{stringProp(props, 'id')}</span>
          </header>
          <h3>{stringProp(props, 'worker')}</h3>
          {props.summary ? <p>{stringProp(props, 'summary')}</p> : null}
          {props.startedAt ? <time>{stringProp(props, 'startedAt')}</time> : null}
          {props.receiptRef && on('press').bound ? (
            <Button type='text' onClick={() => emit('press')}>
              {stringProp(props, 'receiptRef')}
            </Button>
          ) : null}
          {(['pause', 'resume', 'cancel'] as const).some(
            (event) => on(event).bound || unavailableActionReason(props, event)
          ) ? (
            <div
              className={styles.lifecycleControls}
              role='group'
              aria-label={t('messages.typedUI.lifecycle.controls')}
            >
              {(['pause', 'resume', 'cancel'] as const).map((event) => {
                const reason = unavailableActionReason(props, event);
                if (!on(event).bound && !reason) return null;
                return (
                  <Button
                    key={event}
                    disabled={loading || !on(event).bound}
                    aria-describedby={reason ? `typed-ui-worker-${stringProp(props, 'id')}-unavailable` : undefined}
                    onClick={() => emit(event)}
                  >
                    {t(`messages.typedUI.lifecycle.${event}`)}
                  </Button>
                );
              })}
            </div>
          ) : null}
          {unavailable ? (
            <p
              id={`typed-ui-worker-${stringProp(props, 'id')}-unavailable`}
              className={styles.lifecycleUnavailable}
              role='status'
            >
              {t(
                unavailable === 'durable_transport_unavailable'
                  ? 'messages.typedUI.lifecycle.transportUnavailable'
                  : 'messages.typedUI.actionUnavailable'
              )}
            </p>
          ) : null}
          {children}
        </article>
      );
    }
    case 'DecisionCard': {
      const options = arrayProp<{ id: string; label: string; disabled?: boolean }>(props, 'options');
      return (
        <article className={styles.eveCard} data-kind='decision'>
          <header>
            <Tag>{stringProp(props, 'humanGate', 'HG-4')}</Tag>
            <span>{stringProp(props, 'status', 'open')}</span>
          </header>
          <h3>{stringProp(props, 'title')}</h3>
          {props.rationale ? <p>{stringProp(props, 'rationale')}</p> : null}
          {options.length > 0 ? (
            <div className={styles.buttonGroup}>
              {options.map((option) => (
                <React.Fragment key={option.id}>
                  {on(`select:${option.id}`).bound ? (
                    <Button disabled={option.disabled || loading} onClick={() => emit(`select:${option.id}`)}>
                      {option.label}
                    </Button>
                  ) : (
                    <Tag>{option.label}</Tag>
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : null}
          {on('approve').bound ? (
            <Button type='primary' disabled={loading} onClick={() => emit('approve')}>
              {t('messages.typedUI.requestApproval')}
            </Button>
          ) : null}
          {children}
        </article>
      );
    }
    default:
      return null;
  }
}

export const typedUIRegistry: ComponentRegistry = Object.fromEntries(
  TYPED_UI_COMPONENTS.map((name) => [name, CatalogComponent])
);
