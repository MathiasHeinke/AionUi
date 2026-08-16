import React from 'react';
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatCircleDotsIcon,
  ChatsIcon,
  CheckCircleIcon,
  CheckIcon,
  CheckSquareIcon,
  ClockIcon,
  CodeIcon,
  CopyIcon,
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GearSixIcon,
  LightningIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  PaperclipIcon,
  PaperPlaneTiltIcon,
  PlayCircleIcon,
  PlusIcon,
  PushPinIcon,
  QuestionIcon,
  SignOutIcon,
  SquareIcon,
  StopCircleIcon,
  WarningCircleIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  type Icon,
  type IconProps,
  type IconWeight,
} from 'phosphor-react-native';

export const premiumIconComponents = {
  add: PlusIcon,
  'add-circle-outline': PlusIcon,
  'alert-circle': WarningCircleIcon,
  'alert-circle-outline': WarningCircleIcon,
  'arrow-up-circle': PaperPlaneTiltIcon,
  attach: PaperclipIcon,
  checkbox: CheckSquareIcon,
  checkmark: CheckIcon,
  'checkmark-circle': CheckCircleIcon,
  'chatbubble-ellipses-outline': ChatCircleDotsIcon,
  'chatbubbles-outline': ChatsIcon,
  'chevron-down': CaretDownIcon,
  'chevron-forward': CaretRightIcon,
  'chevron-up': CaretUpIcon,
  close: XIcon,
  'close-circle': XCircleIcon,
  'code-slash': CodeIcon,
  'copy-outline': CopyIcon,
  'document-outline': FileTextIcon,
  'flash-outline': LightningIcon,
  folder: FolderIcon,
  'folder-open': FolderOpenIcon,
  'folder-open-outline': FolderOpenIcon,
  'folder-outline': FolderIcon,
  'hardware-chip-outline': CpuIcon,
  'help-circle': QuestionIcon,
  'log-out-outline': SignOutIcon,
  menu: ListIcon,
  'menu-outline': ListIcon,
  'play-circle': PlayCircleIcon,
  pin: PushPinIcon,
  'refresh-outline': ArrowClockwiseIcon,
  'remove-circle': MinusCircleIcon,
  search: MagnifyingGlassIcon,
  'settings-outline': GearSixIcon,
  'square-outline': SquareIcon,
  'stop-circle': StopCircleIcon,
  time: ClockIcon,
  'warning-outline': WarningIcon,
} as const satisfies Record<string, Icon>;

export type PremiumIconName = keyof typeof premiumIconComponents;

export type PremiumIconProps = Omit<IconProps, 'weight'> & {
  name: PremiumIconName;
  weight?: IconWeight;
};

export function resolvePremiumIcon(name: string): Icon {
  return premiumIconComponents[name as PremiumIconName] ?? QuestionIcon;
}

export function PremiumIcon({ name, weight = 'regular', ...props }: PremiumIconProps) {
  const IconComponent = resolvePremiumIcon(name);

  return <IconComponent {...props} weight={weight} />;
}
