export function balanceReply(result){
  if(result?.kind!=='balance'||typeof result.text!=='string'||result.text.length>500||/[@<>]|https?:|\bsk-/iu.test(result.text))return null;
  return {text:result.text};
}

export const isBalanceQuery=text=>typeof text==='string'&&/^(?:查|查询)\s*(?:DeepSeek|深度求索)\s*(?:账户)?余额[？?。\s]*$/iu.test(text.trim());
