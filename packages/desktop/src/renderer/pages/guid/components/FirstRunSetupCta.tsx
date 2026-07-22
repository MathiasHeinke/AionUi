/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveOnboardingStatusModel } from '@/common/adapter/ipcBridge';
import { Button } from '@arco-design/web-react';
import React from 'react';

export interface FirstRunSetupCtaProps {
  shellEnabled: boolean;
  profileLoaded: boolean;
  onboardingLoading: boolean;
  onboardingModel: ICommandEveOnboardingStatusModel | null;
  label: string;
  className?: string;
  onOpen: () => void;
}

/** Reuses the canonical onboarding-status model; this never creates a second checklist. */
export function shouldShowFirstRunSetupCta(
  input: Pick<FirstRunSetupCtaProps, 'shellEnabled' | 'profileLoaded' | 'onboardingLoading' | 'onboardingModel'>
): boolean {
  if (!input.shellEnabled || !input.profileLoaded || input.onboardingLoading || !input.onboardingModel) return false;
  if (input.onboardingModel.first_value_ready !== true) return true;
  const identity = input.onboardingModel.items?.find((item) => item.id === 'identity');
  return Boolean(identity && identity.state !== 'ok');
}

const FirstRunSetupCta: React.FC<FirstRunSetupCtaProps> = (props) => {
  if (!shouldShowFirstRunSetupCta(props)) return null;

  return (
    <Button
      type='primary'
      shape='round'
      size='large'
      className={props.className}
      data-testid='guid-first-run-setup-cta'
      onClick={props.onOpen}
    >
      {props.label}
    </Button>
  );
};

export default FirstRunSetupCta;
