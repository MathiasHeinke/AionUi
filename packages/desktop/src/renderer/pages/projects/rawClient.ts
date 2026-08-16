import { ipcBridge } from '@/common';
import type { RawProjectWorkspaceClient } from './client';

export const rawProjectWorkspaceClient: RawProjectWorkspaceClient = {
  list: () => ipcBridge.projectWorkspace.list.invoke(),
  listConversationArtifacts: (request) => ipcBridge.projectWorkspace.listConversationArtifacts.invoke(request),
  subscribeConversationArtifacts: (request, listener) =>
    ipcBridge.projectWorkspace.artifactChanged.on((payload) => {
      if (payload.conversation_id === request.conversation_id) listener(payload.artifact);
    }),
  previewCreate: (request) => ipcBridge.projectWorkspace.previewCreate.invoke(request),
  create: (request) => ipcBridge.projectWorkspace.create.invoke(request),
  previewAdopt: (request) => ipcBridge.projectWorkspace.previewAdopt.invoke(request),
  adopt: (request) => ipcBridge.projectWorkspace.adopt.invoke(request),
  updateMetadata: (request) => ipcBridge.projectWorkspace.updateMetadata.invoke(request),
  archive: (request) => ipcBridge.projectWorkspace.archive.invoke(request),
  restore: (request) => ipcBridge.projectWorkspace.restore.invoke(request),
  reveal: (request) => ipcBridge.projectWorkspace.reveal.invoke(request),
  recover: (request) => ipcBridge.projectWorkspace.recover.invoke(request),
  undo: (request) => ipcBridge.projectWorkspace.undo.invoke(request),
  bindConversation: (request) => ipcBridge.projectWorkspace.bindConversation.invoke(request),
  unbindConversation: (request) => ipcBridge.projectWorkspace.unbindConversation.invoke(request),
  previewAssignment: (request) => ipcBridge.projectWorkspace.previewAssignment.invoke(request),
  commitAssignment: (request) => ipcBridge.projectWorkspace.commitAssignment.invoke(request),
};
