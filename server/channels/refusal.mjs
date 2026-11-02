import { assertAgentControl } from '../puma/control.mjs';
import { assertChannelExecution } from '../agent/execution.mjs';

const REFUSALS=new Set(['AGENT_STOPPED','AGENT_CONSENT_REQUIRED','CHANNEL_ACCOUNT_UNAVAILABLE']);
export const accountUnavailable=(bank,userId)=>Boolean(bank.get("SELECT 1 FROM accounts WHERE user_id=? AND type='debit' AND status<>'active'",userId));
// States the depositor settles in the App, not faults of the channel: the message is stored, answered with this
// text and never run later. Letting them throw would fail the inbound batch and replay it after the state clears.
export function channelRefusal(bank,binding) {
  try{assertAgentControl(bank,binding.user_id);assertChannelExecution(bank,{channel:binding.channel,bindingId:binding.id},binding.user_id);return null;}
  catch(error){if(REFUSALS.has(error.code))return error.message;throw error;}
}
