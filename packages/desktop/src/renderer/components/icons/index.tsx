/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Icon, IconProps, IconWeight } from '@phosphor-icons/react';
import {
  Alarm as PhAlarm,
  AlignBottom as PhAlignBottom,
  ArrowCircleLeft as PhArrowCircleLeft,
  ArrowClockwise as PhArrowClockwise,
  ArrowCounterClockwise as PhArrowCounterClockwise,
  ArrowElbowLeftUp as PhArrowElbowLeftUp,
  ArrowElbowRightDown as PhArrowElbowRightDown,
  ArrowLeft as PhArrowLeft,
  ArrowRight as PhArrowRight,
  ArrowSquareOut as PhArrowSquareOut,
  ArrowUp as PhArrowUp,
  ArrowsInSimple as PhArrowsInSimple,
  ArrowsOut as PhArrowsOut,
  ArrowsOutSimple as PhArrowsOutSimple,
  BookOpen as PhBookOpen,
  Brain as PhBrain,
  Browser as PhBrowser,
  CalendarDots as PhCalendarDots,
  Camera as PhCamera,
  CaretDoubleLeft as PhCaretDoubleLeft,
  CaretDoubleRight as PhCaretDoubleRight,
  CaretDown as PhCaretDown,
  CaretLeft as PhCaretLeft,
  CaretRight as PhCaretRight,
  CaretUp as PhCaretUp,
  Cat as PhCat,
  ChartBar as PhChartBar,
  ChartLine as PhChartLine,
  ChatCircle as PhChatCircle,
  ChatCircleText as PhChatCircleText,
  ChatTeardropText as PhChatTeardropText,
  ChatsCircle as PhChatsCircle,
  Check as PhCheck,
  CheckCircle as PhCheckCircle,
  CircleNotch as PhCircleNotch,
  Clock as PhClock,
  ClockCounterClockwise as PhClockCounterClockwise,
  CloudArrowUp as PhCloudArrowUp,
  Code as PhCode,
  Columns as PhColumns,
  Command as PhCommand,
  Copy as PhCopy,
  Cpu as PhCpu,
  Crown as PhCrown,
  Cube as PhCube,
  Desktop as PhDesktop,
  DesktopTower as PhDesktopTower,
  DotsSixVertical as PhDotsSixVertical,
  DotsThree as PhDotsThree,
  DotsThreeVertical as PhDotsThreeVertical,
  DownloadSimple as PhDownloadSimple,
  Export as PhExport,
  Eye as PhEye,
  EyeSlash as PhEyeSlash,
  File as PhFile,
  FilePdf as PhFilePdf,
  FileText as PhFileText,
  Flag as PhFlag,
  Folder as PhFolder,
  FolderDashed as PhFolderDashed,
  FolderOpen as PhFolderOpen,
  FolderPlus as PhFolderPlus,
  FolderSimple as PhFolderSimple,
  FolderSimplePlus as PhFolderSimplePlus,
  FolderStar as PhFolderStar,
  Gauge as PhGauge,
  GearSix as PhGearSix,
  GitBranch as PhGitBranch,
  GlobeHemisphereWest as PhGlobeHemisphereWest,
  GridFour as PhGridFour,
  Hammer as PhHammer,
  Heartbeat as PhHeartbeat,
  House as PhHouse,
  Image as PhImage,
  Images as PhImages,
  Info as PhInfo,
  Key as PhKey,
  Ladder as PhLadder,
  Lightbulb as PhLightbulb,
  Lightning as PhLightning,
  Link as PhLink,
  ListChecks as PhListChecks,
  ListNumbers as PhListNumbers,
  Lock as PhLock,
  LockOpen as PhLockOpen,
  MagicWand as PhMagicWand,
  MagnifyingGlass as PhMagnifyingGlass,
  Microphone as PhMicrophone,
  MicrosoftExcelLogo as PhMicrosoftExcelLogo,
  MicrosoftWordLogo as PhMicrosoftWordLogo,
  Minus as PhMinus,
  MinusCircle as PhMinusCircle,
  Moon as PhMoon,
  MusicNotes as PhMusicNotes,
  PaperPlaneTilt as PhPaperPlaneTilt,
  Paperclip as PhPaperclip,
  Pause as PhPause,
  PauseCircle as PhPauseCircle,
  Pencil as PhPencil,
  PencilLine as PhPencilLine,
  PencilSimple as PhPencilSimple,
  PlayCircle as PhPlayCircle,
  Plus as PhPlus,
  PlusCircle as PhPlusCircle,
  Power as PhPower,
  PresentationChart as PhPresentationChart,
  PushPin as PhPushPin,
  PuzzlePiece as PhPuzzlePiece,
  Pulse as PhPulse,
  Question as PhQuestion,
  Quotes as PhQuotes,
  Robot as PhRobot,
  RocketLaunch as PhRocketLaunch,
  Shield as PhShield,
  Sidebar as PhSidebar,
  SignIn as PhSignIn,
  SmileySad as PhSmileySad,
  SpeakerHigh as PhSpeakerHigh,
  Sparkle as PhSparkle,
  Spinner as PhSpinner,
  SpinnerGap as PhSpinnerGap,
  Square as PhSquare,
  SquaresFour as PhSquaresFour,
  Stack as PhStack,
  Stop as PhStop,
  Sun as PhSun,
  TerminalWindow as PhTerminalWindow,
  Trash as PhTrash,
  Tray as PhTray,
  UploadSimple as PhUploadSimple,
  User as PhUser,
  UserFocus as PhUserFocus,
  Users as PhUsers,
  UsersThree as PhUsersThree,
  VideoCamera as PhVideoCamera,
  Wallet as PhWallet,
  Warning as PhWarning,
  WarningCircle as PhWarningCircle,
  Wrench as PhWrench,
  X as PhX,
  XCircle as PhXCircle,
} from '@phosphor-icons/react';
import React, { forwardRef } from 'react';

export type PremiumIconTheme = 'outline' | 'filled' | 'two-tone' | 'multi-color';

/**
 * Transitional props keep existing call sites stable while every visible glyph
 * is rendered by Phosphor. Legacy stroke widths are intentionally ignored so
 * the application has one calm optical weight instead of per-screen drift.
 */
export type PremiumIconProps = Omit<IconProps, 'color' | 'fill'> &
  Readonly<{
    color?: string;
    fill?: string | readonly string[];
    spin?: boolean;
    theme?: PremiumIconTheme;
    title?: string;
  }>;

function resolveColor(color: string | undefined, fill: PremiumIconProps['fill']): string | undefined {
  if (color) return color;
  if (!fill) return undefined;
  if (typeof fill !== 'string') return fill.find((value) => value && value !== 'none' && value !== 'transparent');
  if (fill === 'none' || fill === 'transparent') return undefined;
  return fill;
}

function resolveWeight(weight: IconWeight | undefined, theme: PremiumIconTheme | undefined): IconWeight {
  if (weight) return weight;
  if (theme === 'filled') return 'fill';
  if (theme === 'two-tone' || theme === 'multi-color') return 'duotone';
  return 'regular';
}

export function createPremiumIcon(
  displayName: string,
  IconComponent: Icon,
  defaults: Readonly<Pick<PremiumIconProps, 'mirrored'>> = {}
) {
  const PremiumIcon = forwardRef<SVGSVGElement, PremiumIconProps>((props, ref) => {
    const {
      className,
      color,
      fill,
      spin = false,
      strokeWidth: legacyStrokeWidth,
      theme,
      title,
      weight,
      children,
      ...svgProps
    } = props;
    void legacyStrokeWidth;

    return (
      <IconComponent
        {...defaults}
        {...svgProps}
        ref={ref}
        color={resolveColor(color, fill)}
        weight={resolveWeight(weight, theme)}
        className={['eve-icon', 'eve-phosphor-icon', spin ? 'eve-icon--spin' : '', className].filter(Boolean).join(' ')}
        data-icon-family='phosphor'
        focusable='false'
      >
        {title ? <title>{title}</title> : children}
      </IconComponent>
    );
  });
  PremiumIcon.displayName = displayName;
  return PremiumIcon;
}

export const AddOne = createPremiumIcon('AddOne', PhPlusCircle);
export const AlarmClock = createPremiumIcon('AlarmClock', PhAlarm);
export const AllApplication = createPremiumIcon('AllApplication', PhSquaresFour);
export const Analysis = createPremiumIcon('Analysis', PhChartBar);
export const ArrowCircleLeft = createPremiumIcon('ArrowCircleLeft', PhArrowCircleLeft);
export const ArrowLeft = createPremiumIcon('ArrowLeft', PhArrowLeft);
export const ArrowRight = createPremiumIcon('ArrowRight', PhArrowRight);
export const ArrowUp = createPremiumIcon('ArrowUp', PhArrowUp);
export const Attention = createPremiumIcon('Attention', PhWarning);
export const Book = createPremiumIcon('Book', PhBookOpen);
export const BottomBar = createPremiumIcon('BottomBar', PhAlignBottom);
export const Box = createPremiumIcon('Box', PhCube);
export const Brain = createPremiumIcon('Brain', PhBrain);
export const BranchOne = createPremiumIcon('BranchOne', PhGitBranch);
export const CalendarThirty = createPremiumIcon('CalendarThirty', PhCalendarDots);
export const Camera = createPremiumIcon('Camera', PhCamera);
export const Cat = createPremiumIcon('Cat', PhCat);
export const Caution = createPremiumIcon('Caution', PhWarningCircle);
export const ChartLine = createPremiumIcon('ChartLine', PhChartLine);
export const Check = createPremiumIcon('Check', PhCheck);
export const CheckCircle = createPremiumIcon('CheckCircle', PhCheckCircle);
export const Checklist = createPremiumIcon('Checklist', PhListChecks);
export const CheckOne = createPremiumIcon('CheckOne', PhCheckCircle);
export const CheckSmall = createPremiumIcon('CheckSmall', PhCheck);
export const Close = createPremiumIcon('Close', PhX);
export const CloseOne = createPremiumIcon('CloseOne', PhXCircle);
export const CloseSmall = createPremiumIcon('CloseSmall', PhX);
export const Code = createPremiumIcon('Code', PhCode);
export const Command = createPremiumIcon('Command', PhCommand);
export const Comment = createPremiumIcon('Comment', PhChatCircle);
export const Communication = createPremiumIcon('Communication', PhChatTeardropText);
export const Computer = createPremiumIcon('Computer', PhDesktop);
export const Copy = createPremiumIcon('Copy', PhCopy);
export const CornerDownRight = createPremiumIcon('CornerDownRight', PhArrowElbowRightDown);
export const CornerUpLeft = createPremiumIcon('CornerUpLeft', PhArrowElbowLeftUp);
export const Cpu = createPremiumIcon('Cpu', PhCpu);
export const Crown = createPremiumIcon('Crown', PhCrown);
export const Cube = createPremiumIcon('Cube', PhCube);
export const DashboardOne = createPremiumIcon('DashboardOne', PhGauge);
export const Delete = createPremiumIcon('Delete', PhTrash);
export const DeleteFive = createPremiumIcon('DeleteFive', PhTrash);
export const DeleteFour = createPremiumIcon('DeleteFour', PhTrash);
export const DeleteOne = createPremiumIcon('DeleteOne', PhTrash);
export const DoubleLeft = createPremiumIcon('DoubleLeft', PhCaretDoubleLeft);
export const DoubleRight = createPremiumIcon('DoubleRight', PhCaretDoubleRight);
export const Down = createPremiumIcon('Down', PhCaretDown);
export const Download = createPremiumIcon('Download', PhDownloadSimple);
export const Drag = createPremiumIcon('Drag', PhDotsSixVertical);
export const Earth = createPremiumIcon('Earth', PhGlobeHemisphereWest);
export const Edit = createPremiumIcon('Edit', PhPencilSimple);
export const EditOne = createPremiumIcon('EditOne', PhPencil);
export const EditTwo = createPremiumIcon('EditTwo', PhPencilLine);
export const EmotionUnhappy = createPremiumIcon('EmotionUnhappy', PhSmileySad);
export const Empty = createPremiumIcon('Empty', PhTray);
export const ExpandDownOne = createPremiumIcon('ExpandDownOne', PhCaretDown);
export const ExpandLeft = createPremiumIcon('ExpandLeft', PhCaretLeft);
export const ExpandRight = createPremiumIcon('ExpandRight', PhCaretRight);
export const Export = createPremiumIcon('Export', PhExport);
export const FileExcel = createPremiumIcon('FileExcel', PhMicrosoftExcelLogo);
export const File = createPremiumIcon('File', PhFile);
export const FilePdf = createPremiumIcon('FilePdf', PhFilePdf);
export const FileText = createPremiumIcon('FileText', PhFileText);
export const FileWord = createPremiumIcon('FileWord', PhMicrosoftWordLogo);
export const Flag = createPremiumIcon('Flag', PhFlag);
export const Folder = createPremiumIcon('Folder', PhFolder);
export const FolderBlock = createPremiumIcon('FolderBlock', PhFolderDashed);
export const FolderClose = createPremiumIcon('FolderClose', PhFolderSimple);
export const FolderFocus = createPremiumIcon('FolderFocus', PhFolderStar);
export const FolderOpen = createPremiumIcon('FolderOpen', PhFolderOpen);
export const FolderPlus = createPremiumIcon('FolderPlus', PhFolderPlus);
export const FolderUpload = createPremiumIcon('FolderUpload', PhFolderSimplePlus);
export const FoldUpOne = createPremiumIcon('FoldUpOne', PhCaretUp);
export const FullScreen = createPremiumIcon('FullScreen', PhArrowsOutSimple);
export const FullScreenOne = createPremiumIcon('FullScreenOne', PhArrowsOut);
export const HammerAndAnvil = createPremiumIcon('HammerAndAnvil', PhHammer);
export const Heartbeat = createPremiumIcon('Heartbeat', PhHeartbeat);
export const Help = createPremiumIcon('Help', PhQuestion);
export const History = createPremiumIcon('History', PhClockCounterClockwise);
export const Home = createPremiumIcon('Home', PhHouse);
export const ImageFiles = createPremiumIcon('ImageFiles', PhImages);
export const Info = createPremiumIcon('Info', PhInfo);
export const Inspection = createPremiumIcon('Inspection', PhMagnifyingGlass);
export const Install = createPremiumIcon('Install', PhDownloadSimple);
export const Key = createPremiumIcon('Key', PhKey);
export const Ladder = createPremiumIcon('Ladder', PhLadder);
export const Layers = createPremiumIcon('Layers', PhStack);
export const Left = createPremiumIcon('Left', PhCaretLeft);
export const LeftBar = createPremiumIcon('LeftBar', PhSidebar);
export const Lightning = createPremiumIcon('Lightning', PhLightning);
export const Link = createPremiumIcon('Link', PhLink);
export const LinkCloud = createPremiumIcon('LinkCloud', PhCloudArrowUp);
export const ListCheckbox = createPremiumIcon('ListCheckbox', PhListChecks);
export const ListNumbers = createPremiumIcon('ListNumbers', PhListNumbers);
export const Loading = createPremiumIcon('Loading', PhCircleNotch);
export const LoadingOne = createPremiumIcon('LoadingOne', PhSpinnerGap);
export const LoadingTwo = createPremiumIcon('LoadingTwo', PhSpinner);
export const Lock = createPremiumIcon('Lock', PhLock);
export const Login = createPremiumIcon('Login', PhSignIn);
export const Magic = createPremiumIcon('Magic', PhMagicWand);
export const MagicHat = createPremiumIcon('MagicHat', PhMagicWand);
export const MessageOne = createPremiumIcon('MessageOne', PhChatCircleText);
export const Microphone = createPremiumIcon('Microphone', PhMicrophone);
export const Minus = createPremiumIcon('Minus', PhMinus);
export const Moon = createPremiumIcon('Moon', PhMoon);
export const More = createPremiumIcon('More', PhDotsThree);
export const MoreOne = createPremiumIcon('MoreOne', PhDotsThreeVertical);
export const Music = createPremiumIcon('Music', PhMusicNotes);
export const OffScreen = createPremiumIcon('OffScreen', PhArrowsInSimple);
export const Open = createPremiumIcon('Open', PhArrowSquareOut);
export const Paperclip = createPremiumIcon('Paperclip', PhPaperclip);
export const Pause = createPremiumIcon('Pause', PhPause);
export const PauseOne = createPremiumIcon('PauseOne', PhPauseCircle);
export const People = createPremiumIcon('People', PhUsers);
export const Peoples = createPremiumIcon('Peoples', PhUsersThree);
export const Picture = createPremiumIcon('Picture', PhImage);
export const PlayOne = createPremiumIcon('PlayOne', PhPlayCircle);
export const Plus = createPremiumIcon('Plus', PhPlus);
export const Power = createPremiumIcon('Power', PhPower);
export const PreviewCloseOne = createPremiumIcon('PreviewCloseOne', PhEyeSlash);
export const PreviewOpen = createPremiumIcon('PreviewOpen', PhEye);
export const Projector = createPremiumIcon('Projector', PhPresentationChart);
export const Pushpin = createPremiumIcon('Pushpin', PhPushPin);
export const Puzzle = createPremiumIcon('Puzzle', PhPuzzlePiece);
export const Pulse = createPremiumIcon('Pulse', PhPulse);
export const Quote = createPremiumIcon('Quote', PhQuotes);
export const Redo = createPremiumIcon('Redo', PhArrowClockwise);
export const ReduceOne = createPremiumIcon('ReduceOne', PhMinusCircle);
export const Refresh = createPremiumIcon('Refresh', PhArrowClockwise);
export const Right = createPremiumIcon('Right', PhCaretRight);
export const RightBar = createPremiumIcon('RightBar', PhSidebar, { mirrored: true });
export const Robot = createPremiumIcon('Robot', PhRobot);
export const RocketLaunch = createPremiumIcon('RocketLaunch', PhRocketLaunch);
export const Search = createPremiumIcon('Search', PhMagnifyingGlass);
export const Send = createPremiumIcon('Send', PhPaperPlaneTilt);
export const SettingComputer = createPremiumIcon('SettingComputer', PhDesktopTower);
export const SettingOne = createPremiumIcon('SettingOne', PhGearSix);
export const Shield = createPremiumIcon('Shield', PhShield);
export const Speed = createPremiumIcon('Speed', PhGauge);
export const Sparkle = createPremiumIcon('Sparkle', PhSparkle);
export const SpinnerGap = createPremiumIcon('SpinnerGap', PhSpinnerGap);
export const Split = createPremiumIcon('Split', PhColumns);
export const Square = createPremiumIcon('Square', PhStop);
export const SquareSmall = createPremiumIcon('SquareSmall', PhSquare);
export const SunOne = createPremiumIcon('SunOne', PhSun);
export const System = createPremiumIcon('System', PhGridFour);
export const Terminal = createPremiumIcon('Terminal', PhTerminalWindow);
export const Time = createPremiumIcon('Time', PhClock);
export const Tips = createPremiumIcon('Tips', PhLightbulb);
export const Tool = createPremiumIcon('Tool', PhWrench);
export const TopicDiscussion = createPremiumIcon('TopicDiscussion', PhChatsCircle);
export const Undo = createPremiumIcon('Undo', PhArrowCounterClockwise);
export const Unlock = createPremiumIcon('Unlock', PhLockOpen);
export const Up = createPremiumIcon('Up', PhCaretUp);
export const UploadOne = createPremiumIcon('UploadOne', PhUploadSimple);
export const UploadWeb = createPremiumIcon('UploadWeb', PhCloudArrowUp);
export const User = createPremiumIcon('User', PhUser);
export const UserPositioning = createPremiumIcon('UserPositioning', PhUserFocus);
export const UsersThree = createPremiumIcon('UsersThree', PhUsersThree);
export const Video = createPremiumIcon('Video', PhVideoCamera);
export const ViewGridCard = createPremiumIcon('ViewGridCard', PhSquaresFour);
export const VolumeNotice = createPremiumIcon('VolumeNotice', PhSpeakerHigh);
export const Wallet = createPremiumIcon('Wallet', PhWallet);
export const WebPage = createPremiumIcon('WebPage', PhBrowser);
export const Write = createPremiumIcon('Write', PhPencilLine);
export const XCircle = createPremiumIcon('XCircle', PhXCircle);
