/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

type IconParkProps = {
  className?: string;
  strokeWidth?: number;
  fill?: string;
};

const IconParkHOC = <T extends object>(Component: React.FunctionComponent<T>): React.FC<T & IconParkProps> => {
  return (props) => {
    const { className, ...restProps } = props;
    return React.createElement(Component, {
      ...(restProps as T),
      className: ['eve-icon', className].filter(Boolean).join(' '),
    } as T);
  };
};

export default IconParkHOC;
