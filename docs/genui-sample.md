```dsh-ui
{
  "title": "Remote 图表验收",
  "items": [
    {
      "type": "grid",
      "cols": 2,
      "items": [
        {
          "type": "stat",
          "label": "本周完成",
          "value": "128",
          "delta": "+12%"
        },
        {
          "type": "progress",
          "label": "完成率",
          "value": 75,
          "target": 90
        }
      ]
    },
    {
      "type": "chart",
      "kind": "bars",
      "data": [
        {
          "label": "周一",
          "value": 12
        },
        {
          "label": "周二",
          "value": 24
        },
        {
          "label": "周三",
          "value": -6
        }
      ]
    },
    {
      "type": "chart",
      "kind": "line",
      "series": [
        {
          "label": "计划",
          "color": "#2563eb",
          "data": [
            {
              "label": "一月",
              "value": 20
            },
            {
              "label": "二月",
              "value": 40
            }
          ]
        },
        {
          "label": "实际",
          "color": "#059669",
          "data": [
            {
              "label": "一月",
              "value": 25
            },
            {
              "label": "二月",
              "value": 35
            }
          ]
        }
      ]
    },
    {
      "type": "chart",
      "kind": "donut",
      "data": [
        {
          "label": "完成",
          "value": 75
        },
        {
          "label": "待办",
          "value": 25
        }
      ]
    },
    {
      "type": "table",
      "columns": [
        "项目",
        "数量"
      ],
      "rows": [
        [
          "完成",
          75
        ],
        [
          "待办",
          25
        ]
      ]
    },
    {
      "type": "button",
      "label": "提交",
      "action": "submit"
    }
  ]
}
```
