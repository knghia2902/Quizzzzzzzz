const questions = [
  {
    id: 'q01',
    prompt: 'Phủ định siêu hình là gì?',
    options: { A: 'Loại bỏ sạch trơn, không kế thừa', B: 'Loại bỏ có chọn lọc', C: 'Giữ lại toàn bộ cái cũ', D: 'Không liên quan đến phát triển' },
    correctOption: 'A',
    explanation: 'Phủ định siêu hình loại bỏ sạch trơn cái cũ, không giữ lại những yếu tố tích cực.'
  },
  {
    id: 'q02',
    prompt: 'Phủ định biện chứng khác phủ định siêu hình ở điểm nào?',
    options: { A: 'Phủ định sạch trơn', B: 'Vừa loại bỏ vừa kế thừa', C: 'Không thay đổi gì', D: 'Chỉ diễn ra trong tự nhiên' },
    correctOption: 'B',
    explanation: 'Phủ định biện chứng vừa loại bỏ cái lỗi thời vừa kế thừa những yếu tố tích cực của cái cũ.'
  },
  {
    id: 'q03',
    prompt: 'Tính khách quan của phủ định biện chứng là gì?',
    options: { A: 'Do con người áp đặt', B: 'Do mâu thuẫn nội tại của sự vật', C: 'Do xã hội quyết định', D: 'Do ý chí chủ quan' },
    correctOption: 'B',
    explanation: 'Phủ định biện chứng bắt nguồn từ mâu thuẫn và sự vận động nội tại của chính sự vật.'
  },
  {
    id: 'q04',
    prompt: 'Tính kế thừa của phủ định biện chứng thể hiện thế nào?',
    options: { A: 'Giữ lại toàn bộ cái cũ', B: 'Loại bỏ tất cả cái cũ', C: 'Giữ lại yếu tố tích cực, cải tạo phù hợp', D: 'Không giữ lại gì' },
    correctOption: 'C',
    explanation: 'Kế thừa biện chứng là giữ lại yếu tố tích cực của cái cũ và cải tạo chúng cho phù hợp.'
  },
  {
    id: 'q05',
    prompt: 'Ví dụ khoa học nào thể hiện phủ định biện chứng?',
    options: { A: 'Thuyết Darwin phủ định thuyết tiến hóa', B: 'Thuyết tương đối phủ định thuyết Newton', C: 'Thuyết Big Bang phủ định thuyết Trái đất phẳng', D: 'Thuyết lượng tử phủ định thuyết Einstein' },
    correctOption: 'B',
    explanation: 'Thuyết tương đối vượt qua giới hạn của cơ học Newton và kế thừa những giá trị phù hợp của nó.'
  },
  {
    id: 'q06',
    prompt: 'Trong văn hóa, chữ Quốc ngữ phủ định chữ Nôm theo cách nào?',
    options: { A: 'Loại bỏ hoàn toàn ngôn ngữ Việt', B: 'Giữ lại tinh hoa ngôn ngữ Việt, dễ học hơn', C: 'Không liên quan đến chữ Nôm', D: 'Chỉ dùng trong văn bản hành chính' },
    correctOption: 'B',
    explanation: 'Chữ Quốc ngữ thay đổi hình thức ghi chép nhưng vẫn giữ lại tinh hoa của ngôn ngữ Việt.'
  },
  {
    id: 'q07',
    prompt: 'Phủ định biện chứng có tính phổ biến nghĩa là gì?',
    options: { A: 'Chỉ diễn ra trong xã hội', B: 'Chỉ diễn ra trong tự nhiên', C: 'Diễn ra trong tự nhiên, xã hội và tư duy', D: 'Chỉ diễn ra trong tư duy' },
    correctOption: 'C',
    explanation: 'Phủ định biện chứng là quá trình phổ biến, diễn ra trong tự nhiên, xã hội và tư duy.'
  },
  {
    id: 'q08',
    prompt: 'Quy luật phủ định của phủ định chỉ ra khuynh hướng phát triển như thế nào?',
    options: { A: 'Đi xuống', B: 'Đi lên theo đường xoáy ốc', C: 'Đi ngang', D: 'Không thay đổi' },
    correctOption: 'B',
    explanation: 'Quy luật chỉ ra khuynh hướng phát triển đi lên theo đường xoáy ốc, có kế thừa và nâng cao.'
  },
  {
    id: 'q09',
    prompt: 'Một chu kỳ phủ định của phủ định cần ít nhất bao nhiêu lần phủ định?',
    options: { A: '1', B: '2', C: '3', D: '4' },
    correctOption: 'B',
    explanation: 'Tên gọi phủ định của phủ định cho thấy một chu kỳ tối thiểu gồm hai lần phủ định kế tiếp.'
  },
  {
    id: 'q10',
    prompt: 'Ví dụ tự nhiên nào minh họa phủ định của phủ định?',
    options: { A: 'Nước → hơi nước → mây', B: 'Hạt giống → cây → quả → hạt giống mới', C: 'Đá → cát → xi măng', D: 'Mặt trời → ánh sáng → bóng tối' },
    correctOption: 'B',
    explanation: 'Hạt giống phát triển thành cây, tạo quả và hạt giống mới ở trình độ cao hơn.'
  },
  {
    id: 'q11',
    prompt: 'Ví dụ xã hội nào minh họa phủ định của phủ định?',
    options: { A: 'Nô lệ → phong kiến → tư bản → xã hội mới', B: 'Tư bản → phong kiến → nô lệ', C: 'Xã hội nguyên thủy → tư bản → phong kiến', D: 'Tư bản → xã hội nguyên thủy → phong kiến' },
    correctOption: 'A',
    explanation: 'Chuỗi hình thái xã hội minh họa sự thay thế kế tiếp, trong đó cái mới kế thừa và phát triển hơn.'
  },
  {
    id: 'q12',
    prompt: 'Ví dụ trong công nghệ thể hiện phủ định của phủ định?',
    options: { A: 'Máy ảnh phim → máy ảnh kỹ thuật số → smartphone', B: 'Xe ngựa → xe hơi → xe ngựa', C: 'Máy tính → bàn tính → smartphone', D: 'Điện thoại bàn → máy fax → điện thoại bàn' },
    correctOption: 'A',
    explanation: 'Công nghệ chụp ảnh chuyển từ phim sang kỹ thuật số rồi tích hợp trong smartphone ở trình độ cao hơn.'
  },
  {
    id: 'q13',
    prompt: 'Quá trình học tập có phải là phủ định của phủ định không?',
    options: { A: 'Có, vì kiến thức cũ được nâng cao', B: 'Không, vì kiến thức cũ mất đi', C: 'Có, vì kiến thức cũ bị loại bỏ sạch trơn', D: 'Không, vì học tập không liên quan phủ định' },
    correctOption: 'A',
    explanation: 'Học tập phủ định sự hiểu biết cũ theo hướng nâng cao, chứ không xóa bỏ sạch trơn kiến thức đã có.'
  },
  {
    id: 'q14',
    prompt: 'Đường xoáy ốc trong phủ định của phủ định có ý nghĩa gì?',
    options: { A: 'Phát triển lặp lại nhưng nâng cao', B: 'Phát triển đi xuống', C: 'Phát triển vòng tròn không thay đổi', D: 'Phát triển ngẫu nhiên' },
    correctOption: 'A',
    explanation: 'Đường xoáy ốc diễn tả sự lặp lại tương đối nhưng mỗi vòng phát triển ở trình độ cao hơn.'
  },
  {
    id: 'q15',
    prompt: 'Theo Lênin, sự phát triển diễn ra theo hình thức nào?',
    options: { A: 'Đường thẳng', B: 'Đường tròn', C: 'Đường trôn ốc', D: 'Đường gấp khúc' },
    correctOption: 'C',
    explanation: 'Theo Lênin, phát triển diễn ra theo đường trôn ốc, quanh co nhưng có xu hướng tiến lên.'
  },
  {
    id: 'q16',
    prompt: 'Ý nghĩa lớn nhất của quy luật phủ định của phủ định là gì?',
    options: { A: 'Chỉ ra khuynh hướng đi xuống', B: 'Chỉ ra khuynh hướng tiến lên, vừa kế thừa vừa đổi mới', C: 'Chỉ ra sự lặp lại vòng tròn', D: 'Chỉ ra sự mất đi hoàn toàn cái cũ' },
    correctOption: 'B',
    explanation: 'Quy luật cho thấy phát triển tiến lên bằng cách kế thừa những mặt tích cực và đổi mới chúng.'
  },
  {
    id: 'q17',
    prompt: 'Quy luật này giúp ta nhận thức thế nào về sự phát triển?',
    options: { A: 'Phát triển thẳng tắp, không có bước lùi', B: 'Phát triển quanh co, phức tạp, nhưng tiến bộ', C: 'Phát triển đi xuống', D: 'Phát triển ngẫu nhiên' },
    correctOption: 'B',
    explanation: 'Sự phát triển có thể quanh co, phức tạp và có bước lùi tạm thời nhưng khuynh hướng chung là tiến bộ.'
  },
  {
    id: 'q18',
    prompt: 'Trong học tập, phủ định của phủ định được vận dụng như thế nào?',
    options: { A: 'Loại bỏ toàn bộ kiến thức cũ', B: 'Kế thừa kiến thức cũ, đổi mới phương pháp học', C: 'Không cần kiến thức cũ', D: 'Chỉ học lại kiến thức cũ' },
    correctOption: 'B',
    explanation: 'Vận dụng quy luật trong học tập là kế thừa nền tảng cũ đồng thời đổi mới phương pháp để tiến bộ.'
  },
  {
    id: 'q19',
    prompt: 'Trong đổi mới xã hội, cần kế thừa những yếu tố nào của cái cũ?',
    options: { A: 'Tư tưởng bảo thủ', B: 'Giá trị văn hóa, đạo đức, truyền thống tốt đẹp', C: 'Thói quen lỗi thời', D: 'Những yếu tố lạc hậu' },
    correctOption: 'B',
    explanation: 'Đổi mới xã hội cần kế thừa các giá trị văn hóa, đạo đức và truyền thống tốt đẹp của quá khứ.'
  },
  {
    id: 'q20',
    prompt: 'Tại sao không thể phủ định sạch trơn quá khứ?',
    options: { A: 'Vì cái mới luôn hình thành trên nền tảng cái cũ', B: 'Vì cái mới không cần cái cũ', C: 'Vì cái cũ không có giá trị', D: 'Vì phủ định sạch trơn là tốt nhất' },
    correctOption: 'A',
    explanation: 'Cái mới hình thành trên nền tảng cái cũ nên phải chọn lọc kế thừa, không thể phủ định sạch trơn quá khứ.'
  }
];

export { questions };
