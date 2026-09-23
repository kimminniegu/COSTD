"""Shared development-request fields; only these fields reach the research form/PDF."""

SECTIONS = [
    ("01 기본정보", [
        ("customer", "고객사", "text"), ("product_name", "품명(가칭)", "text"),
        ("sample_request_type", "샘플 구분", "sample_type"),
        ("product_type", "제품 유형", "type"), ("target_price_tier", "목표 가격대", "tier"),
        ("export_countries", "수출 대상국", "list"),
        ("buyer_prohibited_ingredients", "수출 금지 원료", "list"),
    ]),
    ("02 제품 개발 요구사항", [
        ("benchmark_product_name", "벤치마크 제품명", "text"),
        ("product_development.product_description", "제품 설명", "textarea"),
        ("product_development.formula_guidelines", "처방 가이드", "textarea"),
        ("product_development.texture", "제형 / 텍스처", "textarea"),
        ("product_development.appearance_sensory", "사용감 / 외관", "textarea"),
        ("product_development.viscosity", "점도", "text"),
        ("product_development.fragrance_flavor", "향 / Flavor", "text"),
        ("product_development.finish", "피니시", "text"),
        ("product_development.coverage", "커버력", "text"),
        ("product_development.color_shade_reference", "컬러 / 쉐이드 참고", "textarea"),
        ("product_development.other_requirements", "기타 요구사항", "textarea"),
    ]),
    ("03 원료 요구사항", [
        ("ingredients.necessary", "필수 적용 원료", "list"),
        ("ingredients.ideal", "선호 원료", "list"),
    ]),
    ("04 사용 정보", [
        ("usage.application_type", "사용 타입", "application"),
        ("usage.directions_for_use", "사용 방법", "textarea"),
        ("usage.additional_comments", "추가 참고사항", "textarea"),
    ]),
    ("05 품질 확인사항", [
        ("quality.stability.required", "안정도 시험", "required"),
        ("quality.stability.duration", "안정도 기간", "text"),
        ("quality.stability.responsibility", "안정도 책임 주체", "text"),
    ]),
]
FIELDS = {key: kind for _, fields in SECTIONS for key, _, kind in fields}
FIELDS.update(product_type_custom="text", regulatory_restricted_ingredients="list")


def get_value(data, path, default=None):
    for key in path.split("."):
        if not isinstance(data, dict) or key not in data:
            return default
        data = data[key]
    return data


def set_value(data, path, value):
    keys = path.split(".")
    for key in keys[:-1]:
        data = data.setdefault(key, {})
    data[keys[-1]] = value


def empty_value(kind):
    return [] if kind == "list" else None if kind == "required" else ""
