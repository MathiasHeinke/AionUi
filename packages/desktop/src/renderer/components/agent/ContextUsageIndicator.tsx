/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Popover } from '@arco-design/web-react';
import React, { useMemo } from 'react';

import type { TokenUsageData } from '@/common/config/storage';

// 按模型解析上下文窗口（内部回退到 DEFAULT_CONTEXT_LIMIT）
import { resolveEffectiveContextLimit } from '@/renderer/utils/model/modelContextLimits';
// Claude-Code-style popover body: context window + credits (with "Nachkaufen").
import ContextCreditsPopover from './ContextCreditsPopover';

interface ContextUsageIndicatorProps {
  tokenUsage: TokenUsageData | null;
  context_limit?: number;
  /**
   * Active model id — used to resolve the context window when no live `context_limit`
   * has arrived yet (cold start). The cloud lane (GLM 5.2 / DeepSeek V4 = 1M) must NOT
   * read as 64k like a local model; the registry resolves the right window per model.
   */
  modelId?: string;
  className?: string;
  size?: number;
  /** Render only the ring when a parent control already owns the details menu. */
  showDetails?: boolean;
}

const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({
  tokenUsage,
  context_limit,
  modelId,
  className = '',
  size = 24,
  showDetails = true,
}) => {
  // Model-sensitive context window. On the CLOUD lane the window follows the MODEL
  // (floored at its registry size) so the local-runtime 64k compaction cap that
  // Hermes misreports on cloud turns can't pin "EVE Cloud · Max" at 64k; on the
  // LOCAL lane the live frame size IS the real runtime window and wins. See
  // resolveEffectiveContextLimit for the full rationale.
  const effectiveLimit = resolveEffectiveContextLimit(modelId, context_limit);

  // The ring fill + warning/danger thresholds. The full numeric readout now lives
  // in the popover body (<ContextCreditsPopover/>), so this only feeds the SVG.
  const { percentage, isWarning, isDanger } = useMemo(() => {
    if (!tokenUsage) {
      return { percentage: 0, isWarning: false, isDanger: false };
    }
    const pct = (tokenUsage.total_tokens / effectiveLimit) * 100;
    return {
      percentage: pct,
      isWarning: pct > 70,
      isDanger: pct > 90,
    };
  }, [tokenUsage, effectiveLimit]);

  // 计算圆环参数
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // 根据状态获取颜色
  const getStrokeColor = () => {
    if (isDanger) return 'rgb(var(--danger-6))';
    if (isWarning) return 'rgb(var(--warning-6))';
    return 'var(--eve-brand-logo)';
  };

  // Background ring color adapts through the active theme token.
  const trackColor = 'var(--color-fill-3)';

  // The popover body = the Claude-Code-style context + credits panel. The ring
  // itself still derives its fill from `percentage` (above); the panel owns the
  // full readout + the credits section + "Nachkaufen".
  const popoverContent = (
    <ContextCreditsPopover tokenUsage={tokenUsage} contextLimit={context_limit} modelId={modelId} />
  );

  const ring = (
    <div
      className={`context-usage-indicator flex items-center justify-center ${showDetails ? 'cursor-pointer' : ''} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        {/* 背景圆环 */}
        <circle cx={size / 2} cy={size / 2} r={radius} fill='none' stroke={trackColor} strokeWidth={strokeWidth} />
        {/* 进度圆环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill='none'
          stroke={getStrokeColor()}
          strokeWidth={strokeWidth}
          strokeLinecap='round'
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease' }}
        />
      </svg>
    </div>
  );

  if (!showDetails) return ring;

  return (
    <Popover content={popoverContent} position='top' trigger='hover' className='context-usage-popover'>
      {ring}
    </Popover>
  );
};

/**
 * 格式化 token 数量显示
 * @param count token 数量
 * @param hideZeroDecimals 是否隐藏小数点为0的情况（如 1.0M 显示为 1M），默认为 false
 * @returns 格式化后的字符串，如 "37.0K" 或 "1.2M"，当 hideZeroDecimals 为 true 时 "1.0M" 显示为 "1M"
 */
export function formatTokenCount(count: number, hideZeroDecimals = false): string {
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    const formatted = value.toFixed(1);
    return hideZeroDecimals && formatted.endsWith('.0') ? `${Math.floor(value)}M` : `${formatted}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    const formatted = value.toFixed(1);
    return hideZeroDecimals && formatted.endsWith('.0') ? `${Math.floor(value)}K` : `${formatted}K`;
  }
  return count.toString();
}

export default ContextUsageIndicator;
