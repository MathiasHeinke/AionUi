/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConfigProviderProps } from '@arco-design/web-react';
import {
  AddOne,
  Attention,
  CheckSmall,
  Close,
  CloseSmall,
  DoubleLeft,
  DoubleRight,
  Down,
  Drag,
  Empty as EmptyIcon,
  Left,
  LoadingOne,
  More,
  Right,
} from '@icon-park/react';
import React from 'react';

type PremiumComponentConfig = NonNullable<ConfigProviderProps['componentConfig']>;

type SystemIconProps = Readonly<{
  'aria-hidden'?: boolean;
  className?: string;
}>;

const systemIcon = (icon: React.ReactElement<SystemIconProps>): React.ReactElement =>
  React.cloneElement(icon, {
    'aria-hidden': true,
    className: 'eve-system-icon',
  });

const closeSmall = systemIcon(<CloseSmall size={13} />);
const left = systemIcon(<Left size={14} />);
const right = systemIcon(<Right size={14} />);
const down = systemIcon(<Down size={13} />);

/**
 * One Icon Park vocabulary for Arco's internally rendered controls.
 *
 * Product code already uses Icon Park directly, but Select, Menu, Empty,
 * Modal and friends otherwise inject a second icon family behind our back.
 * ConfigProvider is the narrow native seam that lets every instance inherit
 * the same round 3px stroke without forking those components.
 */
export const PREMIUM_ARCO_COMPONENT_CONFIG: PremiumComponentConfig = {
  Breadcrumb: { separator: right },
  Cascader: {
    icons: {
      loading: systemIcon(<LoadingOne size={14} />),
      checked: systemIcon(<CheckSmall size={14} />),
      next: right,
    },
  },
  Collapse: { expandIcon: right },
  DatePicker: {
    icons: {
      prev: left,
      prevDouble: systemIcon(<DoubleLeft size={14} />),
      next: right,
      nextDouble: systemIcon(<DoubleRight size={14} />),
    },
  },
  Drawer: { closeIcon: systemIcon(<Close size={16} />) },
  Empty: {
    icon: (
      <span className='eve-empty-state__icon' aria-hidden='true'>
        <EmptyIcon size={30} />
      </span>
    ),
  },
  Input: { clearIcon: closeSmall },
  'Input.TextArea': { clearIcon: closeSmall },
  InputTag: { icon: { removeIcon: closeSmall, clearIcon: closeSmall } },
  Menu: {
    icons: {
      horizontalArrowDown: down,
      popArrowRight: right,
      collapseDefault: right,
      collapseActive: down,
    },
  },
  Modal: { closeIcon: systemIcon(<Close size={16} />) },
  Pagination: { icons: { prev: left, next: right, more: systemIcon(<More size={14} />) } },
  Popconfirm: { icon: systemIcon(<Attention size={18} />) },
  Select: { arrowIcon: down, removeIcon: closeSmall, clearIcon: closeSmall },
  Tabs: {
    icons: {
      add: systemIcon(<AddOne size={14} />),
      delete: closeSmall,
      prev: left,
      next: right,
      dropdown: down,
    },
  },
  Tag: { closeIcon: closeSmall },
  Tree: {
    icons: {
      dragIcon: systemIcon(<Drag size={14} />),
      switcherIcon: right,
      loadingIcon: systemIcon(<LoadingOne size={14} />),
    },
  },
};
