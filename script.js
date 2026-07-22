function addProduct() {
  const product = document.getElementById("product-name").value.trim();
  const stock = document.getElementById("current-stock").value;
  const reorder = document.getElementById("reorder-level").value;
  const result = document.getElementById("stock-result");

  if (!product || stock === "" || reorder === "") {
    result.textContent = "Please fill in all fields.";
    result.className = "error";
    return;
  }

  const isLow = Number(stock) <= Number(reorder);
  const item = document.createElement("div");

  item.className = isLow ? "low-stock" : "enough-stock";

  item.textContent = isLow
    ? "LOW STOCK: " + product + " needs to be reordered."
    : product + " has enough stock.";

  if (isLow) {
    result.insertBefore(item, result.firstChild);
  } else {
    result.appendChild(item);
  }

  document.getElementById("product-name").value = "";
  document.getElementById("current-stock").value = "";
  document.getElementById("reorder-level").value = "";
}

document.getElementById("stock-form").addEventListener("submit", function (event) {
  event.preventDefault();
  addProduct();
});