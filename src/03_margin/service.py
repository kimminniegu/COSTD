import math
from datetime import datetime

# 마진 시뮬레이션 목업 데이터
MARGIN_DATA = {
    "project": {
        "item_name": "Hydro Moisture Serum 50ml",
        "item_code": "BC-SR-2026",
        "pcs_per_outbox": 100,
        "box_dimensions_mm": {"l": 400, "w": 300, "h": 250},
        "box_gross_weight_kg": 12.0
    },
    "cost_tiers": [
        {"tier_id": "T1", "moq": 3000, "exw_cost_krw": 1700, "target_margin_pct": 35.0},
        {"tier_id": "T2", "moq": 5000, "exw_cost_krw": 1600, "target_margin_pct": 35.0},
        {"tier_id": "T3", "moq": 10000, "exw_cost_krw": 1500, "target_margin_pct": 35.0},
    ],
    "quotations": []
}

def calculate_simulation(data):
    qty = int(data.get("qty", 10000))
    exw_cost_krw = float(data.get("exw_cost_krw", 1500))
    incoterms = data.get("incoterms", "FOB")
    
    # 1. CBM 및 중량 계산
    pcs_per_box = int(MARGIN_DATA["project"]["pcs_per_outbox"])
    box_dim = MARGIN_DATA["project"]["box_dimensions_mm"]
    total_boxes = math.ceil(qty / pcs_per_box)
    box_cbm = (box_dim["l"] * box_dim["w"] * box_dim["h"]) / 1_000_000_000
    total_cbm = round(box_cbm * total_boxes, 3)
    total_weight_kg = round(total_boxes * MARGIN_DATA["project"]["box_gross_weight_kg"], 1)

    # 2. 물류비 및 환율
    local_charge_krw = float(data.get("local_charge_krw", 0))
    freight_usd = float(data.get("freight_usd", 0))
    insurance_krw = float(data.get("insurance_krw", 0))
    base_fx_rate = float(data.get("base_fx_rate", 1350.0))
    fx_stress_pct = float(data.get("fx_stress_pct", 0.0))
    applied_fx_rate = round(base_fx_rate * (1 + (fx_stress_pct / 100.0)), 2)

    total_logistics_krw = local_charge_krw
    if incoterms == "CIF":
        total_logistics_krw += (freight_usd * applied_fx_rate) + insurance_krw
        
    unit_logistics_krw = round(total_logistics_krw / qty, 2)
    total_cost_per_unit_krw = round(exw_cost_krw + unit_logistics_krw, 2)

    # 3. 바이어 외화 제안가 역산
    target_price_usd = float(data.get("target_price_usd", 1.70))
    selling_price_krw = target_price_usd * applied_fx_rate
    unit_margin_krw = round(selling_price_krw - total_cost_per_unit_krw, 2)
    margin_pct = round((unit_margin_krw / selling_price_krw) * 100, 2) if selling_price_krw > 0 else 0
    total_margin_krw = round(unit_margin_krw * qty, 0)
    status = "SAFE" if margin_pct >= 25 else ("REVIEW" if margin_pct >= 15 else "DANGER")

    return {
        "logistics": {
            "total_boxes": total_boxes,
            "total_cbm": total_cbm,
            "total_weight_kg": total_weight_kg,
            "unit_logistics_krw": unit_logistics_krw,
            "total_cost_per_unit_krw": total_cost_per_unit_krw
        },
        "fx": {"applied_fx_rate": applied_fx_rate},
        "result": {
            "selling_price_krw": round(selling_price_krw, 0),
            "unit_margin_krw": unit_margin_krw,
            "total_margin_krw": total_margin_krw,
            "margin_pct": margin_pct,
            "status": status
        }
    }

def save_pi_version(data):
    now = datetime.now()
    version_count = len(MARGIN_DATA["quotations"]) + 1
    new_pi = {
        "version": f"v{version_count}.0",
        "pi_number": f"PI-{now.strftime('%Y%m%d')}-{version_count:02d}",
        "issue_date": now.strftime("%Y-%m-%d"),
        "qty": int(data.get("qty")),
        "incoterms": data.get("incoterms"),
        "unit_price_usd": float(data.get("unit_price_usd")),
        "total_amount_usd": round(int(data.get("qty")) * float(data.get("unit_price_usd")), 2),
        "margin_pct": float(data.get("margin_pct")),
        "total_cbm": float(data.get("total_cbm")),
        "total_boxes": int(data.get("total_boxes")),
        "memo": data.get("memo", "네고 합의 스냅샷")
    }
    MARGIN_DATA["quotations"].insert(0, new_pi)
    return new_pi, MARGIN_DATA["quotations"]