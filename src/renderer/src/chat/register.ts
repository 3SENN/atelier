/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerLogCard } from './cards/registry'
import { ApprovalScopeCard, AutoApprovalCard, SiteAccessCard, TableWriteCard } from './cards/RequestCards'
import { QuestionCard } from './cards/QuestionCard'
import {
  AppBuiltCard,
  AutoApprovalRecord,
  BrowserStepsCard, DelegationCard,
  FileWrittenCard,
  Nothing,
  QuestionRecord,
  RoutineListCard,
  RoutineProposalCard,
  SiteAccessRecord,
  SkillDraftCard,
  TableWriteRecord,
} from './cards/AgentToolCards'
import { startChatSounds } from './chatSounds'
import { startChatFind } from './find/findRouter'
import { agentToolRequests } from './logic/requests'
import { registerRequestCard, registerRequestSource, type PendingRequest } from './requestCards'
import { PackProposedCard } from './cards/PackProposedCard'

// The chat's renderer registrations, imported once by the chat surfaces
// (AgentPanel loads with the app): request cards in the tray, the
// pending-request source they come from, inline log cards, chat sounds
// and ⌘F in a chat.

registerRequestSource((items, chatId) => agentToolRequests(items, chatId) as PendingRequest[])
registerRequestCard('approval', ApprovalScopeCard)
registerRequestCard('auto-approval', AutoApprovalCard)
registerRequestCard('site-access', SiteAccessCard)
registerRequestCard('table-write', TableWriteCard)
registerRequestCard('question', QuestionCard)

registerLogCard('routine-proposal', RoutineProposalCard)
registerLogCard('routine-list', RoutineListCard)
registerLogCard('skill-draft', SkillDraftCard)
registerLogCard('app-built', AppBuiltCard)
registerLogCard('pack-proposed', PackProposedCard) // docs/packs.md
registerLogCard('delegation', DelegationCard)
registerLogCard('browser-steps', BrowserStepsCard)
registerLogCard('file-written', FileWrittenCard)
registerLogCard('question', QuestionRecord)
registerLogCard('site-access', SiteAccessRecord)
registerLogCard('table-write', TableWriteRecord)
registerLogCard('auto-approval', AutoApprovalRecord)
registerLogCard('plan', Nothing)
registerLogCard('source', Nothing)

startChatSounds()
startChatFind()
