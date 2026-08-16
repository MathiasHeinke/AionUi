/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { CheckCircle, SpinnerGap, XCircle } from '@renderer/components/icons';
import React from 'react';

export type ChannelStatusKind = 'connected' | 'connecting' | 'error';

const ChannelStatusIcon: React.FC<Readonly<{ status: ChannelStatusKind }>> = ({ status }) => {
  if (status === 'connected') return <CheckCircle size={14} weight='fill' aria-hidden='true' />;
  if (status === 'error') return <XCircle size={14} weight='fill' aria-hidden='true' />;
  return <SpinnerGap size={14} spin aria-hidden='true' />;
};

ChannelStatusIcon.displayName = 'ChannelStatusIcon';

export default ChannelStatusIcon;
