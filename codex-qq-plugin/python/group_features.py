"""Trusted per-group capability policy shared by LangChain tool selection."""
FEATURE_KEYS = {
    'chat', 'conversion', 'budget', 'weather', 'air', 'radar', 'campus',
    'status', 'balance', 'images', 'voice', 'memory', 'morningReport',
}
TOOL_FEATURES = {
    'weather_image': 'weather', 'air_quality_image': 'air',
    'radar_image': 'radar', 'radar_catalog': 'radar',
    'convert_units': 'conversion', 'convert_previous_result': 'conversion',
    'living_cost_budget': 'budget', 'openai_service_status': 'status',
    'deepseek_service_status': 'status', 'liang_status': 'status',
    'deepseek_account_balance': 'balance', 'buaa_classroom_query': 'campus',
    'buaa_classroom_recommend': 'campus', 'reply_chat': 'chat',
    'chat_memory': 'memory', 'lookup_current_slang': 'chat',
}


def validate_features(context):
    if not isinstance(context, dict) or 'features' not in context:
        return
    features = context['features']
    legacy=(FEATURE_KEYS-{'morningReport'})|{'notifications'}
    if not isinstance(features, dict) or set(features) not in (FEATURE_KEYS,legacy) or any(type(v) is not bool for v in features.values()):
        raise ValueError('INVALID_GROUP_FEATURES')


def allows_feature(context, feature):
    if not isinstance(context, dict) or context.get('scope') != 'group':
        return True
    validate_features(context)
    if 'features' in context:
        return context['features'].get(feature) is True
    # Older callers already apply their existing white/gray tool policy.
    return True
